-- 1. Atomic rate-limit counters (login, 2FA, email, registration, admin test email).
-- 2. query_history refs get ON DELETE SET NULL, so deleting a user or database nulls them even
--    if a code path forgets to. SQLite cannot add the clause in place, so rebuild.
-- 3. Fresh installs (no users yet) start with registration closed; the first account can still
--    register and becomes the admin. Existing installs keep their current setting.
-- NOTE: only for databases created from these migrations. Databases initialised through
-- POST /api/setup (the documented path, including TABLE_PREFIX deployments) get the same changes
-- by re-running POST /api/setup after deploying.
CREATE TABLE IF NOT EXISTS rate_limits (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_rate_limits_expires ON rate_limits(expires_at);

CREATE TABLE query_history_new (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  database_id TEXT REFERENCES d1_databases(id) ON DELETE SET NULL,
  sql TEXT NOT NULL,
  duration_ms INTEGER,
  row_count INTEGER,
  error TEXT,
  executed_at INTEGER NOT NULL
);

INSERT INTO query_history_new SELECT id, user_id, database_id, sql, duration_ms, row_count, error, executed_at FROM query_history;

DROP TABLE query_history;
ALTER TABLE query_history_new RENAME TO query_history;

CREATE INDEX idx_history_user ON query_history(user_id);
CREATE INDEX idx_history_db ON query_history(database_id);
CREATE INDEX idx_history_executed ON query_history(executed_at);

UPDATE settings SET value = 'false', updated_at = unixepoch()
WHERE key = 'registration_enabled' AND NOT EXISTS (SELECT 1 FROM users);
