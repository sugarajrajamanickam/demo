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


class RateTier(SQLModel, table=True):
    """Rate charged per 100 feet of depth.

    Keyed by ``depth_ft`` which is restricted (at the API layer) to the
    fixed ladder 100, 200, 300, ..., 1000. Exactly 10 rows are seeded on
    first boot so the UI always has something to render.
    """

    __tablename__ = "rate_tiers"

    depth_ft: int = Field(primary_key=True, ge=100, le=1000)
    rate: float = Field(default=0.0, ge=0)
    updated_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
