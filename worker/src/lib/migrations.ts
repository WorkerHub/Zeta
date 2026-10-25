import type { Env } from '../types'
import { tables } from './db'

// ── Versioned schema migrations (single source of truth) ─────────────────────────────────────
// The whole Zeta schema lives here, parameterised by the effective table prefix. The setup
// runner (lib/migrations-runner.ts) applies these in order and records each one in the ledger
// table, so the schema is defined exactly once — there is no second DDL copy to keep in sync.
//
// Authoring rules for future changes (also in README / CLAUDE.md):
//   * append a new `{ name: 'schema_vN', sql }` entry at the END of the list — never edit, reorder
//     or rename an already-merged migration, because databases that already recorded it will not
//     run it again;
//   * migrations must be additive (CREATE TABLE/INDEX IF NOT EXISTS, ALTER TABLE ADD COLUMN,
//     INSERT OR IGNORE) — no drops, renames or rewrites of existing data; destructive changes need
//     their own specification;
//   * statements are separated by `;` and executed with D1's `exec()`, which needs a single line
//     (see lib/migrations-runner.ts) — keep SQL line comments out of migrations;
//   * write the SQL with the prefix helper below (`t('users')`), never with a hardcoded name.
//
// History was collapsed into `schema_v1` (the state after migrations/0001–0006, plus the
// columns/indexes the old PRAGMA probing upgrades added): Zeta has no production data, so there is
// no baseline to seed and no version chain to replay. Future changes start at `schema_v2`.

export interface Migration {
  name: string
  sql: string
}

// The current final schema: 11 tables and their indexes, prefix-aware and idempotent
// (IF NOT EXISTS — the ledger guarantees a migration runs once, the clauses only make a failed,
// half-applied run safe to retry).
function schemaV1(T: ReturnType<typeof tables>): string[] {
  // user_id / database_id are nullable (and nulled by the database itself) so history survives
  // deleting a user or database.
  const historyTableDDL = (name: string): string =>
    `CREATE TABLE IF NOT EXISTS ${name} (
      id TEXT PRIMARY KEY,
      user_id TEXT REFERENCES ${T.users}(id) ON DELETE SET NULL,
      database_id TEXT REFERENCES ${T.d1_databases}(id) ON DELETE SET NULL,
      sql TEXT NOT NULL,
      duration_ms INTEGER,
      row_count INTEGER,
      error TEXT,
      executed_at INTEGER NOT NULL
    )`

  const historyIndexDDL = [
    `CREATE INDEX IF NOT EXISTS idx_${T.query_history}_user ON ${T.query_history}(user_id)`,
    `CREATE INDEX IF NOT EXISTS idx_${T.query_history}_db   ON ${T.query_history}(database_id)`,
    `CREATE INDEX IF NOT EXISTS idx_${T.query_history}_executed ON ${T.query_history}(executed_at)`,
  ]

  const permissionsTableDDL = `CREATE TABLE IF NOT EXISTS ${T.user_database_permissions} (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES ${T.users}(id) ON DELETE CASCADE,
      database_id TEXT NOT NULL REFERENCES ${T.d1_databases}(id) ON DELETE CASCADE,
      permission TEXT NOT NULL DEFAULT 'read' CHECK (permission IN ('read', 'write', 'write_drop')),
      granted_by TEXT REFERENCES ${T.users}(id),
      granted_at INTEGER NOT NULL,
      UNIQUE (user_id, database_id)
    )`

  const permissionsIndexDDL = [
    `CREATE INDEX IF NOT EXISTS idx_${T.user_database_permissions}_user ON ${T.user_database_permissions}(user_id)`,
    `CREATE INDEX IF NOT EXISTS idx_${T.user_database_permissions}_db   ON ${T.user_database_permissions}(database_id)`,
  ]

  return [
    `CREATE TABLE IF NOT EXISTS ${T.users} (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT,
      name TEXT NOT NULL DEFAULT '',
      role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
      email_verified INTEGER NOT NULL DEFAULT 0,
      two_factor_required INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      notebook_run_limit INTEGER
    )`,
    `CREATE INDEX IF NOT EXISTS idx_${T.users}_email ON ${T.users}(email)`,

    `CREATE TABLE IF NOT EXISTS ${T.totp_credentials} (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES ${T.users}(id) ON DELETE CASCADE,
      encrypted_secret TEXT NOT NULL,
      name TEXT NOT NULL DEFAULT 'Authenticator',
      created_at INTEGER NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_${T.totp_credentials}_user ON ${T.totp_credentials}(user_id)`,

    `CREATE TABLE IF NOT EXISTS ${T.passkey_credentials} (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES ${T.users}(id) ON DELETE CASCADE,
      credential_id TEXT NOT NULL UNIQUE,
      public_key TEXT NOT NULL,
      sign_count INTEGER NOT NULL DEFAULT 0,
      name TEXT,
      created_at INTEGER NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_${T.passkey_credentials}_user ON ${T.passkey_credentials}(user_id)`,

    `CREATE TABLE IF NOT EXISTS ${T.d1_databases} (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      binding_name TEXT NOT NULL UNIQUE,
      cf_database_id TEXT,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      created_by TEXT REFERENCES ${T.users}(id)
    )`,

    permissionsTableDDL,
    ...permissionsIndexDDL,

    historyTableDDL(T.query_history),
    ...historyIndexDDL,

    `CREATE TABLE IF NOT EXISTS ${T.settings} (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )`,

    `CREATE TABLE IF NOT EXISTS ${T.audit_logs} (
      id TEXT PRIMARY KEY,
      user_id TEXT REFERENCES ${T.users}(id),
      action TEXT NOT NULL,
      resource TEXT,
      metadata TEXT,
      ip TEXT,
      user_agent TEXT,
      created_at INTEGER NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_${T.audit_logs}_user    ON ${T.audit_logs}(user_id)`,
    `CREATE INDEX IF NOT EXISTS idx_${T.audit_logs}_created ON ${T.audit_logs}(created_at)`,

    `CREATE TABLE IF NOT EXISTS ${T.notebooks} (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES ${T.users}(id) ON DELETE CASCADE,
      name TEXT NOT NULL DEFAULT 'Untitled',
      sql_content TEXT NOT NULL DEFAULT '',
      database_id TEXT REFERENCES ${T.d1_databases}(id) ON DELETE SET NULL,
      position INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_run_seq INTEGER NOT NULL DEFAULT 0
    )`,
    `CREATE INDEX IF NOT EXISTS idx_${T.notebooks}_user ON ${T.notebooks}(user_id)`,

    // Saved notebook run results (see lib/runs.ts). `results` comes last so scans of the metadata
    // columns never touch its overflow pages; the user index covers the storage-quota pruning.
    `CREATE TABLE IF NOT EXISTS ${T.notebook_runs} (
      id TEXT PRIMARY KEY,
      notebook_id TEXT NOT NULL REFERENCES ${T.notebooks}(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES ${T.users}(id) ON DELETE CASCADE,
      database_id TEXT NOT NULL REFERENCES ${T.d1_databases}(id) ON DELETE CASCADE,
      sql TEXT NOT NULL,
      statement_count INTEGER NOT NULL,
      row_count INTEGER NOT NULL,
      error_count INTEGER NOT NULL,
      duration_ms INTEGER NOT NULL,
      storage_truncated INTEGER NOT NULL DEFAULT 0,
      results_bytes INTEGER NOT NULL,
      executed_at INTEGER NOT NULL,
      seq INTEGER,
      results TEXT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_${T.notebook_runs}_user ON ${T.notebook_runs}(user_id, executed_at, id, results_bytes)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_${T.notebook_runs}_seq ON ${T.notebook_runs}(notebook_id, seq)`,

    // Atomic rate-limit counters (see lib/auth.ts)
    `CREATE TABLE IF NOT EXISTS ${T.rate_limits} (
      key TEXT PRIMARY KEY,
      count INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_${T.rate_limits}_expires ON ${T.rate_limits}(expires_at)`,
  ]
}

// The migration list, ordered and parameterised by the effective table prefix.
export function getMigrations(env: Pick<Env, 'TABLE_PREFIX'>): Migration[] {
  return [
    {
      name: 'schema_v1',
      sql: schemaV1(tables(env)).join(';\n'),
    },
  ]
}
