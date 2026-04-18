"""Admin-defined rate ranges + per-foot cost calculator.

Admins define an ordered list of pricing ranges (stored in
``rate_ranges``). Each range has a ``mode`` — ``fixed`` or ``step_up``
— plus a numeric ``rate``.

Range endpoints are 1-indexed **inclusive** for display: the first
range starts at ``0`` (a special marker for "from the surface") and
subsequent ranges must start at ``prev.end_ft + 1`` (no gaps, no
overlaps). The number of feet covered by a range is therefore
``r.end_ft - prev.end_ft`` (or ``r.end_ft`` for the first range).

Every range is partitioned into 100-ft sub-slices starting from its
first billable foot. The per-foot rate charged in the Nth sub-slice
(N = 1, 2, …) depends on the mode:

* ``FIXED``    — every sub-slice charges ``r.rate`` per foot.
* ``STEP_UP``  — sub N charges ``R_prev + r.rate * N`` per foot, where
  ``R_prev`` is the per-foot rate at the **last foot of the previous
  range** (or ``0`` if this is the first range).

After a range, ``R_prev`` for the next range is the rate of its
final sub-slice (``r.rate`` for FIXED, or ``R_prev + r.rate * K``
where ``K = ceil(range_length / 100)`` for STEP_UP).

``compute_cost`` walks the ladder, clips the final sub-slice to the
requested depth, and returns the per-100-ft breakdown + total.
Casing is surfaced as a separate additive fee.
"""
from __future__ import annotations

import math
from datetime import datetime, timezone
from typing import Iterator, List, Tuple

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field, model_validator
from sqlmodel import Session, select

from .auth import get_current_user, require_admin
from .db import engine, get_session
from .models import (
    CasingPrice,
    JobType,
    RateRange,
    RateRangeMode,
    ReborePrice,
    User,
)

# Hard cap on depth the calculator will accept, both to bound server work
# and to protect against unbounded admin ranges. 100_000 ft (~19 miles)
# is deeper than any real well.
MAX_DEPTH_FT: int = 100_000


# ---------------------------------------------------------------------------
# Pydantic DTOs
# ---------------------------------------------------------------------------


class RateRangeIn(BaseModel):
    """One admin-submitted range (no id — replace-all semantics)."""

    start_ft: int = Field(..., ge=0)
    end_ft: int = Field(..., gt=0, le=MAX_DEPTH_FT)
    mode: RateRangeMode
    rate: float = Field(..., ge=0)

    @model_validator(mode="after")
    def _validate(self) -> "RateRangeIn":
        if self.end_ft <= self.start_ft:
            raise ValueError("end_ft must be greater than start_ft")
        return self


class RateRangeOut(BaseModel):
    start_ft: int
    end_ft: int
    mode: RateRangeMode
    rate: float


class DerivedSlice(BaseModel):
    """One 100-ft sub-slice of a range with its resolved per-foot rate.

    ``start_ft`` / ``end_ft`` are 1-indexed inclusive; a full sub-slice
    covers 100 feet (``end_ft - start_ft + 1 == 100``). The final
    sub-slice of a range may be shorter if the range length isn't a
    multiple of 100.
    """

    start_ft: int
    end_ft: int
    rate: float  # per-foot rate charged for every foot in this sub-slice
    mode: RateRangeMode  # mode of the range that produced this sub-slice


class RatesResponse(BaseModel):
    ranges: List[RateRangeOut]
    derived: List[DerivedSlice]
    max_depth_ft: int = MAX_DEPTH_FT


class RatesUpdateRequest(BaseModel):
    ranges: List[RateRangeIn]

    @model_validator(mode="after")
    def _validate_chain(self) -> "RatesUpdateRequest":
        validate_range_chain(self.ranges)
        return self


class CostSlice(BaseModel):
    start_ft: int
    end_ft: int
    feet: float  # feet of this range counted toward the depth (clipped at the tail)
    rate_per_ft: float
    cost: float


class CostBreakdown(BaseModel):
    depth: float
    job_type: JobType
    slices: List[CostSlice]
    amount: float  # sum of depth slice costs (pre-tax taxable value)
    casing_7_pieces: int
    casing_7_price_per_piece: float
    casing_7_amount: float
    casing_10_pieces: int
    casing_10_price_per_piece: float
    casing_10_amount: float
    casing_fee: float  # casing_7_amount + casing_10_amount; added after tax
    rebore_price_per_foot: float  # admin-set flat rate (only meaningful for RE_BORE)
    total: float  # amount + casing_fee (no tax here — invoice layer adds GST)


class CostRequest(BaseModel):
    depth: float = Field(..., ge=0, le=MAX_DEPTH_FT)
    job_type: JobType = Field(default=JobType.NEW_BORE)
    casing_7_pieces: int = Field(default=0, ge=0, le=10_000)
    casing_10_pieces: int = Field(default=0, ge=0, le=10_000)


class CasingPricesOut(BaseModel):
    price_7in: float
    price_10in: float


class CasingPricesUpdate(BaseModel):
    price_7in: float = Field(..., ge=0)
    price_10in: float = Field(..., ge=0)


class ReborePriceOut(BaseModel):
    price_per_foot: float


class ReborePriceUpdate(BaseModel):
    price_per_foot: float = Field(..., ge=0)


router = APIRouter(tags=["rates"])


# ---------------------------------------------------------------------------
# Validation + derivation (pure, DB-free)
# ---------------------------------------------------------------------------


#: Hard cap on how many ranges an admin can define. Keeps
#: ``GET /api/rates`` and the editor UI bounded even if an admin (or
#: compromised admin token) submits an absurd ladder.
MAX_RANGES: int = 50


def validate_range_chain(ranges: List[RateRangeIn]) -> None:
    """Raise ``ValueError`` if the ranges aren't a contiguous 1-indexed chain.

    The first range must start at ``0`` (surface). Every subsequent range
    must start at ``prev.end_ft + 1`` so there are no gaps and no overlaps
    in the billable feet.
    """
    if not ranges:
        raise ValueError("At least one range is required")
    if ranges[0].start_ft != 0:
        raise ValueError("First range must start at 0 ft")

    prev_end = ranges[0].end_ft
    for idx, r in enumerate(ranges[1:], start=2):
        expected = prev_end + 1
        if r.start_ft != expected:
            raise ValueError(
                f"Range {idx} starts at {r.start_ft} ft but must start at "
                f"{expected} ft (one past the previous range's end of {prev_end} ft)"
            )
        prev_end = r.end_ft

    if len(ranges) > MAX_RANGES:
        raise ValueError(
            f"Too many ranges: {len(ranges)} (max {MAX_RANGES})"
        )


def _iter_subs(
    ranges: List[RateRange] | List[RateRangeIn],
) -> Iterator[Tuple[int, int, float, RateRangeMode]]:
    """Yield ``(sub_begin, sub_end, rate_per_ft, mode)`` for every 100-ft sub-slice.

    ``sub_begin`` / ``sub_end`` are depths measured from 0 (surface);
    the sub-slice covers the feet in the half-open interval
    ``(sub_begin, sub_end]``. In display terms the 1-indexed inclusive
    label for the sub is ``sub_begin + 1`` – ``sub_end``.

    ``rate_per_ft`` for a STEP_UP sub is ``R_prev + r.rate * N`` where
    ``R_prev`` is the per-foot rate at the last foot of the previous
    range and ``N`` is the 1-indexed sub-slice number within the
    current range.
    """
    prev_end = 0
    r_prev = 0.0  # rate at the last foot of the previous range
    for r in ranges:
        begin = prev_end
        length = r.end_ft - begin
        if length <= 0:
            continue
        total_subs = math.ceil(length / 100)
        sub_begin = begin
        for n in range(1, total_subs + 1):
            sub_end = min(sub_begin + 100, r.end_ft)
            if r.mode == RateRangeMode.FIXED:
                rate_per_ft = float(r.rate)
            else:  # STEP_UP
                rate_per_ft = r_prev + float(r.rate) * n
            yield sub_begin, sub_end, rate_per_ft, r.mode
            sub_begin = sub_end
        # Update R_prev for the next range — use the per-foot rate at
        # the last foot of this range (= rate of the final sub-slice).
        if r.mode == RateRangeMode.FIXED:
            r_prev = float(r.rate)
        else:
            r_prev = r_prev + float(r.rate) * total_subs
        prev_end = r.end_ft


def derive_slices(ranges: List[RateRange] | List[RateRangeIn]) -> List[DerivedSlice]:
    """Expand the ladder into 100-ft sub-slices with their resolved per-foot rates."""
    return [
        DerivedSlice(
            start_ft=sub_begin + 1,
            end_ft=sub_end,
            rate=rate_per_ft,
            mode=mode,
        )
        for sub_begin, sub_end, rate_per_ft, mode in _iter_subs(ranges)
    ]


def compute_cost(
    ranges: List[RateRange] | List[RateRangeIn],
    depth: float,
    casing_7_pieces: int,
    casing_10_pieces: int,
    price_7in: float,
    price_10in: float,
    *,
    job_type: JobType = JobType.NEW_BORE,
    rebore_price_per_foot: float = 0.0,
) -> CostBreakdown:
    """Compute the per-100-ft cost breakdown + casing add-ons for ``depth``.

    Emits one ``CostSlice`` per 100-ft sub-slice of every range; the
    final sub-slice is truncated at ``depth`` if depth falls inside it.
    The depth must fall inside the admin-defined ladder — if it exceeds
    the last range's ``end_ft`` we surface ``ValueError`` so the caller
    can ask the admin to extend the ladder instead of silently capping
    the cost.

    Casing add-ons: ``casing_N_pieces × price_Nin`` per size, summed
    into ``casing_fee`` and added to the running total *after* tax
    (the invoice layer applies GST only to ``amount``).
    """
    if depth < 0:
        raise ValueError("depth must be >= 0")
    if casing_7_pieces < 0 or casing_10_pieces < 0:
        raise ValueError("casing pieces must be >= 0")
    if price_7in < 0 or price_10in < 0:
        raise ValueError("casing prices must be >= 0")
    if rebore_price_per_foot < 0:
        raise ValueError("rebore price must be >= 0")

    if job_type == JobType.RE_BORE:
        # Re-bore: flat per-foot rate, no casing, no rate-ladder tiers.
        feet = float(depth)
        rate = float(rebore_price_per_foot)
        amount = round(feet * rate, 2)
        slices: List[CostSlice] = []
        if feet > 0:
            slices.append(
                CostSlice(
                    start_ft=1,
                    end_ft=max(1, int(feet)),
                    feet=feet,
                    rate_per_ft=rate,
                    cost=amount,
                )
            )
        return CostBreakdown(
            depth=depth,
            job_type=JobType.RE_BORE,
            slices=slices,
            amount=amount,
            casing_7_pieces=0,
            casing_7_price_per_piece=price_7in,
            casing_7_amount=0.0,
            casing_10_pieces=0,
            casing_10_price_per_piece=price_10in,
            casing_10_amount=0.0,
            casing_fee=0.0,
            rebore_price_per_foot=rate,
            total=amount,
        )

    if not ranges:
        raise ValueError("Rate ladder is empty — admin must define at least one range")

    max_ft = ranges[-1].end_ft
    if depth > max_ft:
        raise ValueError(
            f"Depth {depth} ft exceeds the configured rate ladder ({max_ft} ft). "
            "Ask an admin to add a range covering greater depths."
        )

    cost_slices: List[CostSlice] = []
    amount = 0.0
    for sub_begin, sub_end, rate_per_ft, _mode in _iter_subs(ranges):
        if depth <= sub_begin:
            break
        effective_end = min(float(sub_end), float(depth))
        feet = effective_end - float(sub_begin)
        if feet <= 0:
            continue
        cost = round(feet * rate_per_ft, 4)
        cost_slices.append(
            CostSlice(
                start_ft=sub_begin + 1,
                end_ft=max(sub_begin + 1, int(effective_end)),
                feet=feet,
                rate_per_ft=rate_per_ft,
                cost=cost,
            )
        )
        amount += cost

    amount = round(amount, 2)
    c7_amount = round(casing_7_pieces * price_7in, 2)
    c10_amount = round(casing_10_pieces * price_10in, 2)
    casing_fee = round(c7_amount + c10_amount, 2)
    total = round(amount + casing_fee, 2)
    return CostBreakdown(
        depth=depth,
        job_type=JobType.NEW_BORE,
        slices=cost_slices,
        amount=amount,
        casing_7_pieces=casing_7_pieces,
        casing_7_price_per_piece=price_7in,
        casing_7_amount=c7_amount,
        casing_10_pieces=casing_10_pieces,
        casing_10_price_per_piece=price_10in,
        casing_10_amount=c10_amount,
        casing_fee=casing_fee,
        rebore_price_per_foot=rebore_price_per_foot,
        total=total,
    )


# ---------------------------------------------------------------------------
# Persistence helpers
# ---------------------------------------------------------------------------


DEFAULT_BOOTSTRAP_RANGES: List[RateRangeIn] = [
    RateRangeIn(start_ft=0, end_ft=300, mode=RateRangeMode.FIXED, rate=100.0),
    RateRangeIn(start_ft=301, end_ft=1000, mode=RateRangeMode.STEP_UP, rate=50.0),
    RateRangeIn(start_ft=1001, end_ft=3000, mode=RateRangeMode.STEP_UP, rate=100.0),
]


#: Default per-piece prices seeded on first boot (admin-editable thereafter).
DEFAULT_CASING_PRICE_7IN: float = 0.0
DEFAULT_CASING_PRICE_10IN: float = 0.0
DEFAULT_REBORE_PRICE_PER_FOOT: float = 0.0


def bootstrap_rate_config() -> None:
    """Seed the default ladder + casing prices + rebore price on first boot."""
    with Session(engine) as session:
        existing = session.exec(select(RateRange)).first()
        if existing is None:
            for idx, r in enumerate(DEFAULT_BOOTSTRAP_RANGES):
                session.add(
                    RateRange(
                        start_ft=r.start_ft,
                        end_ft=r.end_ft,
                        mode=r.mode,
                        rate=r.rate,
                        sort_index=idx,
                    )
                )
        if session.get(CasingPrice, 1) is None:
            session.add(
                CasingPrice(
                    id=1,
                    price_7in=DEFAULT_CASING_PRICE_7IN,
                    price_10in=DEFAULT_CASING_PRICE_10IN,
                )
            )
        if session.get(ReborePrice, 1) is None:
            session.add(
                ReborePrice(
                    id=1,
                    price_per_foot=DEFAULT_REBORE_PRICE_PER_FOOT,
                )
            )
        session.commit()


def _get_casing_prices(session: Session) -> CasingPrice:
    row = session.get(CasingPrice, 1)
    if row is None:
        row = CasingPrice(
            id=1,
            price_7in=DEFAULT_CASING_PRICE_7IN,
            price_10in=DEFAULT_CASING_PRICE_10IN,
        )
        session.add(row)
        session.commit()
        session.refresh(row)
    return row


def _get_rebore_price(session: Session) -> ReborePrice:
    row = session.get(ReborePrice, 1)
    if row is None:
        row = ReborePrice(id=1, price_per_foot=DEFAULT_REBORE_PRICE_PER_FOOT)
        session.add(row)
        session.commit()
        session.refresh(row)
    return row


def _list_ranges(session: Session) -> List[RateRange]:
    rows = session.exec(
        select(RateRange).order_by(RateRange.sort_index, RateRange.start_ft)
    ).all()
    return list(rows)


def _build_response(rows: List[RateRange]) -> RatesResponse:
    ranges_out = [
        RateRangeOut(start_ft=r.start_ft, end_ft=r.end_ft, mode=r.mode, rate=r.rate)
        for r in rows
    ]
    return RatesResponse(ranges=ranges_out, derived=derive_slices(rows))


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


@router.get("/api/rates", response_model=RatesResponse)
def get_rates(
    _: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> RatesResponse:
    """Return the admin-defined ranges and derived per-100-ft slices."""
    return _build_response(_list_ranges(session))


@router.put("/api/admin/rates", response_model=RatesResponse)
def update_rates(
    payload: RatesUpdateRequest,
    _: User = Depends(require_admin),
    session: Session = Depends(get_session),
) -> RatesResponse:
    """Admin-only: replace the entire ladder with the submitted ranges."""
    # Delete existing rows and re-insert. Replace-all is simpler than diffing
    # and the ladder is small enough that rewriting it is cheap.
    existing = _list_ranges(session)
    for row in existing:
        session.delete(row)
    session.flush()

    now = datetime.now(timezone.utc)
    for idx, r in enumerate(payload.ranges):
        session.add(
            RateRange(
                start_ft=r.start_ft,
                end_ft=r.end_ft,
                mode=r.mode,
                rate=r.rate,
                sort_index=idx,
                updated_at=now,
            )
        )
    session.commit()
    return _build_response(_list_ranges(session))


@router.post("/api/cost", response_model=CostBreakdown)
def calculate_cost(
    payload: CostRequest,
    _: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> CostBreakdown:
    """Compute drilling amount + casing add-ons + pre-tax total.

    For ``job_type=RE_BORE`` the rate ladder and casing inputs are
    ignored; billing is a flat ``depth * rebore_price_per_foot`` with
    GST applied later by the invoice layer.
    """
    prices = _get_casing_prices(session)
    rebore = _get_rebore_price(session)
    try:
        return compute_cost(
            _list_ranges(session),
            payload.depth,
            payload.casing_7_pieces,
            payload.casing_10_pieces,
            prices.price_7in,
            prices.price_10in,
            job_type=payload.job_type,
            rebore_price_per_foot=rebore.price_per_foot,
        )
    except ValueError as err:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(err))


@router.get("/api/casing-prices", response_model=CasingPricesOut)
def get_casing_prices(
    _: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> CasingPricesOut:
    """Return the admin-set per-piece prices for 7\" and 10\" casing."""
    prices = _get_casing_prices(session)
    return CasingPricesOut(
        price_7in=prices.price_7in, price_10in=prices.price_10in
    )


@router.put("/api/admin/casing-prices", response_model=CasingPricesOut)
def update_casing_prices(
    payload: CasingPricesUpdate,
    _: User = Depends(require_admin),
    session: Session = Depends(get_session),
) -> CasingPricesOut:
    """Admin-only: set per-piece prices for 7\" and 10\" casing."""
    row = _get_casing_prices(session)
    row.price_7in = payload.price_7in
    row.price_10in = payload.price_10in
    row.updated_at = datetime.now(timezone.utc)
    session.add(row)
    session.commit()
    session.refresh(row)
    return CasingPricesOut(price_7in=row.price_7in, price_10in=row.price_10in)


@router.get("/api/rebore-price", response_model=ReborePriceOut)
def get_rebore_price(
    _: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> ReborePriceOut:
    """Return the admin-set flat per-foot re-bore rate."""
    row = _get_rebore_price(session)
    return ReborePriceOut(price_per_foot=row.price_per_foot)


@router.put("/api/admin/rebore-price", response_model=ReborePriceOut)
def update_rebore_price(
    payload: ReborePriceUpdate,
    _: User = Depends(require_admin),
    session: Session = Depends(get_session),
) -> ReborePriceOut:
    """Admin-only: set the flat per-foot re-bore rate."""
    row = _get_rebore_price(session)
    row.price_per_foot = payload.price_per_foot
    row.updated_at = datetime.now(timezone.utc)
    session.add(row)
    session.commit()
    session.refresh(row)
    return ReborePriceOut(price_per_foot=row.price_per_foot)
