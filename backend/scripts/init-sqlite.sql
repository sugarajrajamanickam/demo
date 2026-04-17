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

-- Rate per 100 ft of depth. The application seeds 10 rows on first boot
-- (depth_ft IN (100, 200, ..., 1000)) with rate=0.0 — admins can edit
-- the rates from the Admin page; managers see them read-only on the
-- Calculate page.
CREATE TABLE IF NOT EXISTS rate_tiers (
    depth_ft   INTEGER PRIMARY KEY,
    rate       REAL    NOT NULL DEFAULT 0,
    updated_at TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP
);
