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

-- Rate configuration singleton. The application derives the full
-- per-100-ft ladder from three numbers: the flat base rate for the
-- 0-300 ft band, the mid-band increment (applied to every 100 ft slice
-- in (300, 1000] ft), and the deep-band increment (applied above
-- 1000 ft). The singleton is keyed by id=1 and seeded on first boot.
CREATE TABLE IF NOT EXISTS rate_config (
    id         INTEGER PRIMARY KEY CHECK (id = 1),
    base_rate  REAL    NOT NULL DEFAULT 0,
    step_mid   REAL    NOT NULL DEFAULT 10,
    step_deep  REAL    NOT NULL DEFAULT 100,
    updated_at TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP
);
