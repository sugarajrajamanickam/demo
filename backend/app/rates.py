"""Rate-per-100-feet tier table.

Read endpoint is available to any authenticated user (both admin and
manager) so the Calculate page can show it read-only. Write endpoint is
admin-only, and replaces all 10 rows atomically — this keeps the UI
simple (one Save button per page) and sidesteps partial-update edge
cases (e.g. a half-saved ladder where 500ft is updated but 600ft isn't).
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import List

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlmodel import Session, select

from .auth import get_current_user, require_admin
from .db import engine, get_session
from .models import RateTier, User

# Fixed ladder: 100, 200, 300, ..., 1000 feet.
DEPTH_TIERS: tuple[int, ...] = tuple(range(100, 1001, 100))


class RateRow(BaseModel):
    depth_ft: int = Field(..., ge=100, le=1000)
    rate: float = Field(..., ge=0)


class RatesResponse(BaseModel):
    tiers: List[RateRow]


class RatesUpdateRequest(BaseModel):
    tiers: List[RateRow]


router = APIRouter(tags=["rates"])


def bootstrap_rate_tiers() -> None:
    """Seed the 10 fixed depth tiers on first boot."""
    with Session(engine) as session:
        existing = {
            t.depth_ft for t in session.exec(select(RateTier)).all()
        }
        missing = [d for d in DEPTH_TIERS if d not in existing]
        if not missing:
            return
        for depth_ft in missing:
            session.add(RateTier(depth_ft=depth_ft, rate=0.0))
        session.commit()


def _sorted_tiers(session: Session) -> List[RateRow]:
    rows = session.exec(select(RateTier).order_by(RateTier.depth_ft)).all()
    return [RateRow(depth_ft=r.depth_ft, rate=r.rate) for r in rows]


@router.get("/api/rates", response_model=RatesResponse)
def list_rates(
    _: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> RatesResponse:
    """Any authenticated user (admin or manager) can read the rate table."""
    return RatesResponse(tiers=_sorted_tiers(session))


@router.put("/api/admin/rates", response_model=RatesResponse)
def replace_rates(
    payload: RatesUpdateRequest,
    _: User = Depends(require_admin),
    session: Session = Depends(get_session),
) -> RatesResponse:
    """Replace the entire rate ladder. Admin only.

    Clients must send all 10 rows with the fixed depth values. We reject
    partial updates (missing depths), unknown depths, and duplicates so
    the UI never ends up with a ragged ladder.
    """
    submitted = {row.depth_ft: row.rate for row in payload.tiers}
    if len(submitted) != len(payload.tiers):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Duplicate depth_ft values are not allowed",
        )
    if set(submitted.keys()) != set(DEPTH_TIERS):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                "Payload must include exactly the fixed depths "
                f"{list(DEPTH_TIERS)}"
            ),
        )

    now = datetime.now(timezone.utc)
    for depth_ft in DEPTH_TIERS:
        row = session.get(RateTier, depth_ft)
        if row is None:
            # Shouldn't happen after bootstrap, but stay robust.
            row = RateTier(depth_ft=depth_ft, rate=submitted[depth_ft], updated_at=now)
            session.add(row)
        else:
            row.rate = submitted[depth_ft]
            row.updated_at = now
            session.add(row)
    session.commit()
    return RatesResponse(tiers=_sorted_tiers(session))
