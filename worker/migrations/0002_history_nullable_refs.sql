-- Keep query history when a user or database is deleted: the references become NULL
-- instead of the rows being deleted. SQLite cannot relax NOT NULL in place, so rebuild.
-- NOTE: deployments using TABLE_PREFIX must apply the equivalent change to <prefix>_query_history manually.
CREATE TABLE query_history_new (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id),
  database_id TEXT REFERENCES d1_databases(id),
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
