"""Database engine + session dependency for the demo app.

Default is SQLite (single file at ``APP_DATABASE_PATH``, persisted on the
``app-data`` Docker volume in docker-compose). The schema is documented in
``backend/scripts/init-sqlite.sql`` — you can also apply that script by
hand for a brand-new DB, but it's not required because ``init_db()``
creates the tables via SQLModel on first startup.

Set ``APP_DATABASE_URL`` to any SQLAlchemy-style URL to switch backends
later (e.g. a managed Postgres) without code changes. You'd need to add
the appropriate driver to requirements.txt for non-SQLite URLs.
"""
from __future__ import annotations

import logging
import os
import time
from pathlib import Path
from typing import Iterator

from sqlalchemy.exc import OperationalError
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine

from .models import User  # noqa: F401 ensures models are registered before create_all

logger = logging.getLogger(__name__)


def _database_url() -> str:
    # Allow overrides for tests / managed DBs.
    url = os.getenv("APP_DATABASE_URL")
    if url:
        return url
    default_db = "/app/data/app.db"
    # Fall back to a writable tmp path when the default parent isn't
    # writable (e.g. local dev outside Docker or the auto-generated
    # `deploy backend` container which runs as non-root and has no
    # /app/data). ``init_db()`` creates the tables on first startup.
    try:
        db_path = Path(os.getenv("APP_DATABASE_PATH", default_db))
        db_path.parent.mkdir(parents=True, exist_ok=True)
    except (PermissionError, OSError):
        db_path = Path("/tmp/app.db")
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
else:
    # Sensible defaults for Postgres (and other network DBs): recycle
    # connections before typical server-side idle timeouts.
    _engine_kwargs["pool_pre_ping"] = True
    _engine_kwargs["pool_recycle"] = 1800

engine = create_engine(_DATABASE_URL, connect_args=_connect_args, **_engine_kwargs)


def _sqlite_columns(session_engine, table: str) -> set[str]:
    """Return column names for ``table`` on a SQLite engine (empty set if missing)."""
    from sqlalchemy import text

    with session_engine.connect() as conn:
        rows = conn.execute(text(f"PRAGMA table_info('{table}')")).fetchall()
    return {row[1] for row in rows}


def _migrate_customers_new_fields() -> None:
    """Add customer-request columns to an existing ``customers`` table.

    SQLite-only; no-op for other backends (which would need Alembic).
    Safe to call repeatedly — each ALTER is guarded by a column check.
    Existing rows get their ``date_of_request`` backfilled from
    ``created_at`` so they render sensibly in the Dashboard.
    """
    if not _DATABASE_URL.startswith("sqlite"):
        return
    from sqlalchemy import text

    existing = _sqlite_columns(engine, "customers")
    if not existing:  # table hasn't been created yet
        return
    with engine.begin() as conn:
        if "date_of_request" not in existing:
            conn.execute(text("ALTER TABLE customers ADD COLUMN date_of_request VARCHAR(10) NOT NULL DEFAULT ''"))
            conn.execute(
                text(
                    "UPDATE customers SET date_of_request = substr(created_at, 1, 10) "
                    "WHERE date_of_request = ''"
                )
            )
        if "actual_date_of_bore" not in existing:
            conn.execute(text("ALTER TABLE customers ADD COLUMN actual_date_of_bore VARCHAR(10) NOT NULL DEFAULT ''"))
        if "bore_type" not in existing:
            conn.execute(text("ALTER TABLE customers ADD COLUMN bore_type VARCHAR(16) NOT NULL DEFAULT 'new_bore'"))


def init_db() -> None:
    """Create tables. Idempotent. Called on app startup."""
    SQLModel.metadata.create_all(engine)
    _migrate_customers_new_fields()


def get_session() -> Iterator[Session]:
    with Session(engine) as session:
        yield session
