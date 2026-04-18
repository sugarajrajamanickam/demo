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
    """How a range's ``rate`` value resolves to a per-foot cost.

    * ``FIXED``    — ``rate`` is the absolute per-foot cost charged for
      every foot in the range.
    * ``STEP_UP``  — ``rate`` is a per-foot increment added to the
      *previous* range's resolved per-foot rate; the sum is then charged
      for every foot in this range. (For the very first range with no
      predecessor, the implicit previous rate is ``0``.)
    """

    FIXED = "fixed"
    STEP_UP = "step_up"


class RateRange(SQLModel, table=True):
    """A single admin-defined pricing range of the rate ladder.

    Ranges are contiguous, non-overlapping, in ascending ``start_ft``,
    and the first range must start at ``0``. ``end_ft > start_ft``.
    ``compute_cost`` walks the ranges in order, resolves each to a
    per-foot rate (see :class:`RateRangeMode`), and charges that rate
    for each foot drilled within the range.
    """

    __tablename__ = "rate_ranges"

    id: Optional[int] = Field(default=None, primary_key=True)
    start_ft: int = Field(ge=0)
    end_ft: int = Field(gt=0)
    mode: RateRangeMode = Field(default=RateRangeMode.FIXED)
    rate: float = Field(ge=0)
    sort_index: int = Field(default=0)  # preserves admin-provided order
    updated_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


class CasingPrice(SQLModel, table=True):
    """Singleton row (id=1) holding admin-set per-piece casing prices.

    ``Casing 7"`` and ``Casing 10"`` are charged as ``pieces × price``
    and appear as their own line items in the tax invoice. Casing is
    non-taxable (GST applies only to the drilling amount); the UI
    layer adds the two amounts to the grand total after tax.
    """

    __tablename__ = "casing_prices"

    id: Optional[int] = Field(default=1, primary_key=True)
    price_7in: float = Field(default=0.0, ge=0)
    price_10in: float = Field(default=0.0, ge=0)
    updated_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


class JobType(str, Enum):
    """Kind of drilling job.

    * ``NEW_BORE`` — uses the admin-defined rate ladder (per-foot, tiered)
      plus optional casing add-ons.
    * ``RE_BORE``  — flat per-foot rate managed by admin in a separate
      singleton; billed as ``depth × rate`` with GST applied the same
      way drilling is, and no casing.
    """

    NEW_BORE = "new_bore"
    RE_BORE = "re_bore"


class ReborePrice(SQLModel, table=True):
    """Singleton row (id=1) holding the admin-set flat per-foot re-bore rate."""

    __tablename__ = "rebore_prices"

    id: Optional[int] = Field(default=1, primary_key=True)
    price_per_foot: float = Field(default=0.0, ge=0)
    updated_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


class QuotationSettings(SQLModel, table=True):
    """Singleton row (id=1) holding admin-configurable quotation settings.

    ``validity_days`` is the number of days a quotation is valid for once
    issued; rendered on the quotation as a "Valid until" date calculated
    from the quote date.
    """

    __tablename__ = "quotation_settings"

    id: Optional[int] = Field(default=1, primary_key=True)
    validity_days: int = Field(default=30, ge=1, le=3650)
    updated_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
