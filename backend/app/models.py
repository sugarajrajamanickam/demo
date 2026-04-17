"""SQLModel user table with role-based access control."""
from __future__ import annotations

from datetime import datetime, timezone
from enum import Enum
from typing import Optional

from sqlmodel import Field, SQLModel


class Role(str, Enum):
    ADMIN = "admin"
    MANAGER = "manager"


class User(SQLModel, table=True):
    """Application user. Login identifier is `username`; `mobile` is also required."""

    __tablename__ = "users"

    id: Optional[int] = Field(default=None, primary_key=True)
    username: str = Field(index=True, unique=True, min_length=1, max_length=64)
    mobile: str = Field(min_length=1, max_length=32)
    password_hash: str = Field(min_length=1, max_length=255)
    role: Role = Field(default=Role.MANAGER)
    full_name: Optional[str] = Field(default=None, max_length=128)
    # Security question / answer used by the self-serve password-reset flow.
    # Required for admins (enforced at the API layer); optional for managers.
    # The answer is hashed with bcrypt the same way passwords are — never
    # store the plain-text answer.
    security_question: Optional[str] = Field(default=None, max_length=255)
    security_answer_hash: Optional[str] = Field(default=None, max_length=255)
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


class RateRangeMode(str, Enum):
    """How a range's ``rate`` value is applied to each 100 ft slice.

    * ``FIXED``    — every 100 ft slice in the range charges ``rate``.
    * ``STEP_UP``  — each 100 ft slice charges the *previous* slice's rate
      plus ``rate``. (For the very first range with no predecessor, the
      implicit previous rate is ``0``.)
    """

    FIXED = "fixed"
    STEP_UP = "step_up"


class RateRange(SQLModel, table=True):
    """A single admin-defined pricing range of the rate ladder.

    Ranges are contiguous, non-overlapping, in ascending ``start_ft``, and
    the first range must start at ``0``. ``end_ft > start_ft``, both are
    non-negative multiples of 100 so the per-100-ft calculator stays
    integer-clean. ``compute_cost`` walks the ranges in order and extends
    the rate accordingly (see :class:`RateRangeMode`).
    """

    __tablename__ = "rate_ranges"

    id: Optional[int] = Field(default=None, primary_key=True)
    start_ft: int = Field(ge=0)
    end_ft: int = Field(gt=0)
    mode: RateRangeMode = Field(default=RateRangeMode.FIXED)
    rate: float = Field(ge=0)
    sort_index: int = Field(default=0)  # preserves admin-provided order
    updated_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
