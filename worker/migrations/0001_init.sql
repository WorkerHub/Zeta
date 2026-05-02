-- Migration: 0001_init.sql

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT,
  name TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
  email_verified INTEGER NOT NULL DEFAULT 0,
  two_factor_required INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_users_email ON users(email);

CREATE TABLE totp_credentials (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  encrypted_secret TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT 'Authenticator',
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_totp_user ON totp_credentials(user_id);

CREATE TABLE passkey_credentials (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  credential_id TEXT NOT NULL UNIQUE,
  public_key TEXT NOT NULL,
  sign_count INTEGER NOT NULL DEFAULT 0,
  name TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_passkey_user ON passkey_credentials(user_id);

CREATE TABLE d1_databases (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  binding_name TEXT NOT NULL UNIQUE,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  created_by TEXT REFERENCES users(id)
);

CREATE TABLE user_database_permissions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  database_id TEXT NOT NULL REFERENCES d1_databases(id) ON DELETE CASCADE,
  permission TEXT NOT NULL DEFAULT 'read' CHECK (permission IN ('read', 'write')),
  granted_by TEXT REFERENCES users(id),
  granted_at INTEGER NOT NULL,
  UNIQUE (user_id, database_id)
);

CREATE INDEX idx_perm_user ON user_database_permissions(user_id);
CREATE INDEX idx_perm_db ON user_database_permissions(database_id);

CREATE TABLE query_history (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  database_id TEXT NOT NULL REFERENCES d1_databases(id),
  sql TEXT NOT NULL,
  duration_ms INTEGER,
  row_count INTEGER,
  error TEXT,
  executed_at INTEGER NOT NULL
);

CREATE INDEX idx_history_user ON query_history(user_id);
CREATE INDEX idx_history_db ON query_history(database_id);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE audit_logs (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id),
  action TEXT NOT NULL,
  resource TEXT,
  metadata TEXT,
  ip TEXT,
  user_agent TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_audit_user ON audit_logs(user_id);
CREATE INDEX idx_audit_created ON audit_logs(created_at);

CREATE TABLE notebooks (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL DEFAULT 'Untitled',
  sql_content TEXT NOT NULL DEFAULT '',
  database_id TEXT REFERENCES d1_databases(id) ON DELETE SET NULL,
  position INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_notebooks_user ON notebooks(user_id);

-- Default settings
INSERT INTO settings (key, value, updated_at) VALUES
  ('registration_enabled', 'true', unixepoch()),
  ('require_email_verification', 'false', unixepoch()),
  ('enforce_2fa', 'false', unixepoch()),
  ('email_provider', 'resend', unixepoch()),
  ('resend_api_key', '', unixepoch()),
  ('smtp_host', '', unixepoch()),
  ('smtp_port', '587', unixepoch()),
  ('smtp_user', '', unixepoch()),
  ('smtp_pass', '', unixepoch()),
  ('smtp_from', '', unixepoch()),
  ('app_name', 'Zeta', unixepoch()),
  ('setup_completed', 'false', unixepoch());
