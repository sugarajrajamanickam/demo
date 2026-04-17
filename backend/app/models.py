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


class RateConfig(SQLModel, table=True):
    """Singleton configuration row driving the rate-per-100-ft ladder.

    The ladder is *computed* from three numbers so the admin UI only has to
    persist those three values (instead of N individual rows that could
    drift out of sync):

    * ``base_rate`` — flat rate per 100 ft for the 0–300 ft band.
    * ``step_mid``  — increment applied to every 100 ft band in (300, 1000].
    * ``step_deep`` — increment applied to every 100 ft band above 1000 ft.

    With B = base_rate, m = step_mid, d = step_deep::

        0–100, 100–200, 200–300     : B
        300–400                      : B + m
        400–500                      : B + 2m
        ...
        900–1000                     : B + 7m
        1000–1100                    : B + 7m + d
        1100–1200                    : B + 7m + 2d
        ...

    The table holds a single row, keyed by ``id=1``, so the callers can
    treat it as configuration rather than a list.
    """

    __tablename__ = "rate_config"

    id: int = Field(default=1, primary_key=True)
    base_rate: float = Field(default=0.0, ge=0)
    step_mid: float = Field(default=10.0, ge=0)
    step_deep: float = Field(default=100.0, ge=0)
    updated_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
