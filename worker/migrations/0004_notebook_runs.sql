-- 1. notebook_runs keeps the results of each notebook run so they survive switching tabs,
--    leaving the page, reloading and changing devices. Pruned to the effective per-notebook
--    limit and to the per-user storage quota (see src/lib/runs.ts).
-- 2. users.notebook_run_limit: a user's own (lower) run limit; NULL follows the admin limit.
-- 3. Default admin limits: 100 runs per notebook, 50 MB of stored results per user.
-- NOTE: only for databases created from these migrations. Databases initialised through
-- POST /api/setup (the documented path, including TABLE_PREFIX deployments) get the same changes
-- by re-running POST /api/setup after deploying.
CREATE TABLE IF NOT EXISTS notebook_runs (
  id TEXT PRIMARY KEY,
  notebook_id TEXT NOT NULL REFERENCES notebooks(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  database_id TEXT NOT NULL REFERENCES d1_databases(id) ON DELETE CASCADE,
  sql TEXT NOT NULL,
  statement_count INTEGER NOT NULL,
  row_count INTEGER NOT NULL,
  error_count INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  storage_truncated INTEGER NOT NULL DEFAULT 0,
  results_bytes INTEGER NOT NULL,
  executed_at INTEGER NOT NULL,
  results TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_notebook_runs_notebook ON notebook_runs(notebook_id, executed_at);
CREATE INDEX IF NOT EXISTS idx_notebook_runs_user ON notebook_runs(user_id, executed_at, id, results_bytes);

ALTER TABLE users ADD COLUMN notebook_run_limit INTEGER;

INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES ('notebook_run_limit', '100', unixepoch());
INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES ('run_storage_quota_mb', '50', unixepoch());
