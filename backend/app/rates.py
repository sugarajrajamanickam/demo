"""Rate configuration + banded rate ladder.

The ladder itself is *derived* from three numbers stored in
``rate_config`` (see :class:`app.models.RateConfig`):

* ``base_rate`` — cost per 100 ft in the flat 0–300 ft band.
* ``step_mid``  — increment applied to every 100 ft band in (300, 1000] ft.
* ``step_deep`` — increment applied to every 100 ft band above 1000 ft.

The derived ranges table is shown on the Admin page (admin-editable config,
read-only derived rows) and on the Calculate page (read-only reference, up
to ``DISPLAY_MAX_FT``).

``compute_cost`` is what the Calculate page calls: it takes a target depth
and returns the per-100-ft breakdown plus the total ``amount``. The final
slice is prorated if the depth isn't a multiple of 100.

Read endpoints are available to any authenticated user; write endpoints
are admin-only.
"""
from __future__ import annotations

import math
from datetime import datetime, timezone
from typing import List

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlmodel import Session

from .auth import get_current_user, require_admin
from .db import engine, get_session
from .models import RateConfig, User

# How far the "ranges" reference table is displayed by default. The cost
# calculator itself handles any depth >= 0 (it extends bands on demand).
DISPLAY_MAX_FT: int = 3000

# Inclusive upper end of the flat base band.
FLAT_BAND_END_FT: int = 300

# Inclusive upper end of the "mid" band (where each slice adds step_mid).
MID_BAND_END_FT: int = 1000


# ---------------------------------------------------------------------------
# Pydantic DTOs
# ---------------------------------------------------------------------------


class RateConfigOut(BaseModel):
    base_rate: float = Field(..., ge=0)
    step_mid: float = Field(..., ge=0)
    step_deep: float = Field(..., ge=0)


class RateConfigUpdate(BaseModel):
    base_rate: float = Field(..., ge=0)
    step_mid: float = Field(..., ge=0)
    step_deep: float = Field(..., ge=0)


class RateRange(BaseModel):
    """Derived ranges row shown on the admin / calculate page."""

    start_ft: int = Field(..., ge=0)
    end_ft: int = Field(..., gt=0)
    rate: float = Field(..., ge=0)


class RatesResponse(BaseModel):
    config: RateConfigOut
    ranges: List[RateRange]
    display_max_ft: int = DISPLAY_MAX_FT


class CostSlice(BaseModel):
    """One 100 ft slice (possibly prorated at the tail)."""

    start_ft: int
    end_ft: int
    feet: float  # how many feet of this slice are counted (<=100, prorated)
    rate_per_100ft: float
    cost: float


class CostBreakdown(BaseModel):
    depth: float
    casing: float
    slices: List[CostSlice]
    amount: float  # sum of slice costs (depth-driven)
    casing_fee: float  # alias for casing, surfaced as a dedicated additive fee
    total: float  # amount + casing_fee


router = APIRouter(tags=["rates"])


# ---------------------------------------------------------------------------
# Persistence helpers
# ---------------------------------------------------------------------------


def bootstrap_rate_config() -> None:
    """Seed the singleton rate_config row on first boot."""
    with Session(engine) as session:
        existing = session.get(RateConfig, 1)
        if existing is None:
            session.add(RateConfig(id=1))
            session.commit()


def _get_config(session: Session) -> RateConfig:
    row = session.get(RateConfig, 1)
    if row is None:
        # Defensive: bootstrap_rate_config should have seeded this.
        row = RateConfig(id=1)
        session.add(row)
        session.commit()
        session.refresh(row)
    return row


# ---------------------------------------------------------------------------
# Pure business logic (unit-testable without a DB)
# ---------------------------------------------------------------------------


def rate_for_band(
    start_ft: int,
    base_rate: float,
    step_mid: float,
    step_deep: float,
) -> float:
    """Return the cost-per-100-ft rate for the 100 ft band starting at ``start_ft``.

    ``start_ft`` must be a non-negative multiple of 100.

    * 0, 100, 200                      -> base_rate
    * 300, 400, ..., 900               -> base_rate + (k+1)*step_mid where
                                          k = (start_ft - 300)/100
    * 1000, 1100, 1200, ...            -> base_rate + 7*step_mid + (k+1)*step_deep
                                          where k = (start_ft - 1000)/100
    """
    if start_ft < 0 or start_ft % 100 != 0:
        raise ValueError(f"start_ft must be a non-negative multiple of 100, got {start_ft}")

    if start_ft < FLAT_BAND_END_FT:  # 0, 100, 200
        return base_rate
    if start_ft < MID_BAND_END_FT:  # 300, 400, ..., 900
        k = (start_ft - FLAT_BAND_END_FT) // 100
        return base_rate + (k + 1) * step_mid
    # 1000, 1100, 1200, ...
    mid_slices = (MID_BAND_END_FT - FLAT_BAND_END_FT) // 100  # = 7
    deep_k = (start_ft - MID_BAND_END_FT) // 100
    return base_rate + mid_slices * step_mid + (deep_k + 1) * step_deep


def derive_ranges(cfg: RateConfig, display_max_ft: int = DISPLAY_MAX_FT) -> List[RateRange]:
    """Derive the admin-visible ranges table from ``cfg``.

    The 0–300 ft band is collapsed into a single row (since the rate is
    flat). Everything above that is one row per 100 ft up to
    ``display_max_ft``.
    """
    if display_max_ft <= 0 or display_max_ft % 100 != 0:
        raise ValueError(f"display_max_ft must be a positive multiple of 100, got {display_max_ft}")

    ranges: List[RateRange] = [
        RateRange(start_ft=0, end_ft=FLAT_BAND_END_FT, rate=cfg.base_rate),
    ]
    for start in range(FLAT_BAND_END_FT, display_max_ft, 100):
        ranges.append(
            RateRange(
                start_ft=start,
                end_ft=start + 100,
                rate=rate_for_band(start, cfg.base_rate, cfg.step_mid, cfg.step_deep),
            )
        )
    return ranges


def compute_cost(cfg: RateConfig, depth: float, casing: float) -> CostBreakdown:
    """Compute per-100-ft cost breakdown + totals for a given depth.

    Rate is interpreted as cost per full 100 ft of that band. Partial
    final slice is prorated (``feet/100 * rate``). Casing is surfaced as a
    dedicated additive fee (not driven by the rate ladder).
    """
    if depth < 0:
        raise ValueError("depth must be >= 0")
    if casing < 0:
        raise ValueError("casing must be >= 0")

    slices: List[CostSlice] = []
    amount = 0.0
    remaining = float(depth)
    start = 0
    while remaining > 0:
        rate = rate_for_band(start, cfg.base_rate, cfg.step_mid, cfg.step_deep)
        feet = 100.0 if remaining >= 100 else remaining
        cost = round(feet / 100.0 * rate, 4)
        slices.append(
            CostSlice(
                start_ft=start,
                end_ft=start + int(math.ceil(feet)) if feet < 100 else start + 100,
                feet=feet,
                rate_per_100ft=rate,
                cost=cost,
            )
        )
        amount += cost
        remaining -= feet
        start += 100

    amount = round(amount, 2)
    total = round(amount + casing, 2)
    return CostBreakdown(
        depth=depth,
        casing=casing,
        slices=slices,
        amount=amount,
        casing_fee=casing,
        total=total,
    )


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


@router.get("/api/rates", response_model=RatesResponse)
def get_rates(
    _: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> RatesResponse:
    """Return rate config + the derived ranges table.

    Available to any authenticated user; admins also see this on the Admin
    page (where they can edit the config) and managers see it read-only on
    the Calculate page.
    """
    cfg = _get_config(session)
    return RatesResponse(
        config=RateConfigOut(
            base_rate=cfg.base_rate,
            step_mid=cfg.step_mid,
            step_deep=cfg.step_deep,
        ),
        ranges=derive_ranges(cfg),
    )


@router.put("/api/admin/rates", response_model=RatesResponse)
def update_rates(
    payload: RateConfigUpdate,
    _: User = Depends(require_admin),
    session: Session = Depends(get_session),
) -> RatesResponse:
    """Admin-only: overwrite the rate-config singleton."""
    cfg = _get_config(session)
    cfg.base_rate = payload.base_rate
    cfg.step_mid = payload.step_mid
    cfg.step_deep = payload.step_deep
    cfg.updated_at = datetime.now(timezone.utc)
    session.add(cfg)
    session.commit()
    session.refresh(cfg)
    return RatesResponse(
        config=RateConfigOut(
            base_rate=cfg.base_rate,
            step_mid=cfg.step_mid,
            step_deep=cfg.step_deep,
        ),
        ranges=derive_ranges(cfg),
    )


# Hard cap on depth so an attacker can't request e.g. 1e15 ft and force
# compute_cost into a billion-slice loop (one CostSlice allocated per
# 100 ft). 100_000 ft (~19 miles) is deeper than any realistic well.
MAX_DEPTH_FT: float = 100_000.0


class CostRequest(BaseModel):
    depth: float = Field(..., ge=0, le=MAX_DEPTH_FT)
    casing: float = Field(..., ge=0)


@router.post("/api/cost", response_model=CostBreakdown)
def calculate_cost(
    payload: CostRequest,
    _: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> CostBreakdown:
    """Compute amount (from rate ladder) + casing fee + total for a depth.

    Also returns the per-100-ft slice breakdown so the UI can show a
    transparent cost table before the totals.
    """
    cfg = _get_config(session)
    try:
        return compute_cost(cfg, payload.depth, payload.casing)
    except ValueError as err:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(err))
