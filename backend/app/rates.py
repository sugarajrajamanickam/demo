"""Admin-defined rate ranges + per-foot cost calculator.

Admins define an ordered list of pricing ranges (stored in
``rate_ranges``). Each range has a ``mode`` — ``fixed`` (an absolute
per-foot rate for the entire range) or ``step_up`` (previous range's
per-foot rate + ``range.rate``, applied to every foot in this range) —
plus a numeric ``rate`` whose meaning depends on the mode. In both
modes the resulting per-foot rate is charged for each foot that falls
inside the range.

Validation: ranges must be contiguous, non-overlapping, and start at
0 ft. ``end_ft`` must be strictly greater than ``start_ft``.

``compute_cost`` walks the admin-defined ranges, clips them to the
requested depth, and returns the per-range breakdown + total. Casing
is surfaced as a separate additive fee.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import List

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field, model_validator
from sqlmodel import Session, select

from .auth import get_current_user, require_admin
from .db import engine, get_session
from .models import RateRange, RateRangeMode, User

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
    """One admin-defined range with its resolved per-foot rate."""

    start_ft: int
    end_ft: int
    rate: float  # per-foot rate charged for every foot in this range
    mode: RateRangeMode  # mode of the range that produced this slice


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
    casing: float
    slices: List[CostSlice]
    amount: float
    casing_fee: float
    total: float


class CostRequest(BaseModel):
    depth: float = Field(..., ge=0, le=MAX_DEPTH_FT)
    casing: float = Field(..., ge=0)


router = APIRouter(tags=["rates"])


# ---------------------------------------------------------------------------
# Validation + derivation (pure, DB-free)
# ---------------------------------------------------------------------------


#: Hard cap on how many ranges an admin can define. Keeps
#: ``GET /api/rates`` and the editor UI bounded even if an admin (or
#: compromised admin token) submits an absurd ladder.
MAX_RANGES: int = 50


def validate_range_chain(ranges: List[RateRangeIn]) -> None:
    """Raise ``ValueError`` if the ranges aren't a contiguous chain from 0.

    Contiguity (``start_ft == prev_end``) alone already rules out overlaps,
    but we also enforce the weaker ``start_ft >= prev_end`` explicitly first
    so the error message is unambiguous when ranges overlap (vs. have gaps).
    """
    if not ranges:
        raise ValueError("At least one range is required")
    if ranges[0].start_ft != 0:
        raise ValueError("First range must start at 0 ft")

    prev_end = 0
    for idx, r in enumerate(ranges):
        if r.start_ft < prev_end:
            raise ValueError(
                f"Range {idx + 1} starts at {r.start_ft} ft which overlaps the "
                f"previous range ending at {prev_end} ft"
            )
        if r.start_ft != prev_end:
            raise ValueError(
                f"Range {idx + 1} starts at {r.start_ft} ft but the previous range "
                f"ends at {prev_end} ft (ranges must be contiguous with no gaps)"
            )
        prev_end = r.end_ft

    if len(ranges) > MAX_RANGES:
        raise ValueError(
            f"Too many ranges: {len(ranges)} (max {MAX_RANGES})"
        )


def derive_slices(ranges: List[RateRange] | List[RateRangeIn]) -> List[DerivedSlice]:
    """Resolve each admin-defined range to its per-foot rate.

    Accepts either ORM rows or the request DTO — they share the fields
    this function cares about.

    ``rate`` semantics depend on mode:

    * ``FIXED``   — ``rate`` is an absolute **per-foot** cost charged
      for every foot in the range.
    * ``STEP_UP`` — ``rate`` is a **per-foot increment** on top of the
      previous range's resolved per-foot rate (``0`` if there is no
      predecessor). The resulting per-foot rate is charged for every
      foot in this range.
    """
    slices: List[DerivedSlice] = []
    prev_rate = 0.0
    for r in ranges:
        if r.mode == RateRangeMode.FIXED:
            this_rate = float(r.rate)
        else:  # STEP_UP
            this_rate = prev_rate + float(r.rate)
        slices.append(
            DerivedSlice(
                start_ft=r.start_ft,
                end_ft=r.end_ft,
                rate=this_rate,
                mode=r.mode,
            )
        )
        prev_rate = this_rate
    return slices


def compute_cost(
    ranges: List[RateRange] | List[RateRangeIn],
    depth: float,
    casing: float,
) -> CostBreakdown:
    """Compute the per-range cost breakdown + totals for ``depth``.

    Each range's per-foot rate (resolved via :func:`derive_slices`) is
    multiplied by the feet of drilling that fall within the range, up
    to the requested depth.

    The depth must fall inside the admin-defined ladder — if it exceeds
    the last range's ``end_ft`` we surface ``ValueError`` so the caller
    can ask the admin to extend the ladder instead of silently capping
    the cost.
    """
    if depth < 0:
        raise ValueError("depth must be >= 0")
    if casing < 0:
        raise ValueError("casing must be >= 0")
    if not ranges:
        raise ValueError("Rate ladder is empty — admin must define at least one range")

    max_ft = ranges[-1].end_ft
    if depth > max_ft:
        raise ValueError(
            f"Depth {depth} ft exceeds the configured rate ladder ({max_ft} ft). "
            "Ask an admin to add a range covering greater depths."
        )

    derived = derive_slices(ranges)
    cost_slices: List[CostSlice] = []
    amount = 0.0
    for s in derived:
        if depth <= s.start_ft:
            break
        end_in_range = min(float(depth), float(s.end_ft))
        feet = end_in_range - float(s.start_ft)
        if feet <= 0:
            continue
        cost = round(feet * s.rate, 4)
        cost_slices.append(
            CostSlice(
                start_ft=s.start_ft,
                end_ft=int(end_in_range) if end_in_range != s.end_ft else s.end_ft,
                feet=feet,
                rate_per_ft=s.rate,
                cost=cost,
            )
        )
        amount += cost

    amount = round(amount, 2)
    total = round(amount + casing, 2)
    return CostBreakdown(
        depth=depth,
        casing=casing,
        slices=cost_slices,
        amount=amount,
        casing_fee=casing,
        total=total,
    )


# ---------------------------------------------------------------------------
# Persistence helpers
# ---------------------------------------------------------------------------


DEFAULT_BOOTSTRAP_RANGES: List[RateRangeIn] = [
    RateRangeIn(start_ft=0, end_ft=300, mode=RateRangeMode.FIXED, rate=100.0),
    RateRangeIn(start_ft=300, end_ft=1000, mode=RateRangeMode.STEP_UP, rate=50.0),
    RateRangeIn(start_ft=1000, end_ft=3000, mode=RateRangeMode.STEP_UP, rate=100.0),
]


def bootstrap_rate_config() -> None:
    """Seed the default ladder on first boot so the UI has something to show."""
    with Session(engine) as session:
        existing = session.exec(select(RateRange)).first()
        if existing is not None:
            return
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
        session.commit()


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
    """Compute amount + casing + total for a given depth."""
    try:
        return compute_cost(_list_ranges(session), payload.depth, payload.casing)
    except ValueError as err:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(err))
