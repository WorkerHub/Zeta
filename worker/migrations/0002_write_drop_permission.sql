-- Migration: 0002_write_drop_permission.sql
-- SQLite does not support ALTER TABLE to modify CHECK constraints,
-- so we recreate the table with the updated constraint.

CREATE TABLE user_database_permissions_new (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  database_id TEXT NOT NULL REFERENCES d1_databases(id) ON DELETE CASCADE,
  permission TEXT NOT NULL DEFAULT 'read' CHECK (permission IN ('read', 'write', 'write_drop')),
  granted_by TEXT REFERENCES users(id),
  granted_at INTEGER NOT NULL,
  UNIQUE (user_id, database_id)
);

INSERT INTO user_database_permissions_new
  SELECT * FROM user_database_permissions;

DROP TABLE user_database_permissions;

ALTER TABLE user_database_permissions_new RENAME TO user_database_permissions;

CREATE INDEX idx_perm_user ON user_database_permissions(user_id);
CREATE INDEX idx_perm_db ON user_database_permissions(database_id);
