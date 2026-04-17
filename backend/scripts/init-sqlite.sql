-- SQLite schema for the demo app.
--
-- This file is informational: the application creates these tables
-- automatically on startup via SQLModel (see `backend/app/db.py::init_db`).
-- It's committed so that operators / DBAs can inspect the expected
-- schema, apply it manually to a fresh DB, or diff against an existing
-- DB for drift detection.
--
-- Apply it by hand with:
--     sqlite3 /app/data/app.db < backend/scripts/init-sqlite.sql
--
-- Schema is idempotent (CREATE TABLE IF NOT EXISTS).

CREATE TABLE IF NOT EXISTS user (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    username             TEXT    NOT NULL UNIQUE,
    mobile               TEXT    NOT NULL,
    password_hash        TEXT    NOT NULL,
    role                 TEXT    NOT NULL,                -- 'admin' | 'manager'
    full_name            TEXT,
    -- Self-serve password reset via security question. Question is stored
    -- plain; the answer is bcrypt-hashed (never persisted in plain text).
    -- Required for admins (enforced at the API layer), optional for managers.
    security_question    TEXT,
    security_answer_hash TEXT,
    created_at           TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS ix_users_username ON users(username);

-- Admin-defined rate ranges. Admin maintains a contiguous chain of
-- pricing ranges starting at 0 ft: each range has a mode ("fixed" —
-- flat rate for every 100 ft in the range; "step_up" — rate increases
-- by `rate` for each 100 ft slice, continuing from the previous slice's
-- rate). The application derives the per-100-ft ladder from these rows
-- and uses it to compute depth-based cost at request time. Bootstrap
-- seeds the historical three-band ladder on first boot.
CREATE TABLE IF NOT EXISTS rate_ranges (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    start_ft   INTEGER NOT NULL CHECK (start_ft >= 0 AND start_ft % 100 = 0),
    end_ft     INTEGER NOT NULL CHECK (end_ft   >  0 AND end_ft   % 100 = 0),
    mode       TEXT    NOT NULL CHECK (mode IN ('fixed', 'step_up')),
    rate       REAL    NOT NULL CHECK (rate >= 0),
    sort_index INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS ix_rate_ranges_sort ON rate_ranges(sort_index, start_ft);
