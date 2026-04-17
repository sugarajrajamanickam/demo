"""Database engine + session dependency for the demo app."""
from __future__ import annotations

import os
from pathlib import Path
from typing import Iterator

from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine

from .models import User  # noqa: F401 ensures models are registered before create_all


def _database_url() -> str:
    # Allow overrides for tests / managed DBs.
    url = os.getenv("APP_DATABASE_URL")
    if url:
        return url
    db_path = Path(os.getenv("APP_DATABASE_PATH", "/app/data/app.db"))
    db_path.parent.mkdir(parents=True, exist_ok=True)
    return f"sqlite:///{db_path}"


_DATABASE_URL = _database_url()
_connect_args: dict = {}
_engine_kwargs: dict = {}
if _DATABASE_URL.startswith("sqlite"):
    _connect_args["check_same_thread"] = False
    if _DATABASE_URL.endswith(":memory:") or ":memory:" in _DATABASE_URL:
        # Share one in-memory DB across sessions (used by tests).
        _engine_kwargs["poolclass"] = StaticPool

engine = create_engine(_DATABASE_URL, connect_args=_connect_args, **_engine_kwargs)


def init_db() -> None:
    """Create tables. Idempotent. Called on app startup."""
    SQLModel.metadata.create_all(engine)


def get_session() -> Iterator[Session]:
    with Session(engine) as session:
        yield session
