import { Hono } from 'hono'
import type { Env, Variables } from '../types'
import { now, tables } from '../lib/db'

const setup = new Hono<{ Bindings: Env; Variables: Variables }>()

// ── DDL builder (idempotent – all use IF NOT EXISTS) ──────────────────────────

function buildDDL(T: ReturnType<typeof tables>): string[] {
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
      updated_at INTEGER NOT NULL
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
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      created_by TEXT REFERENCES ${T.users}(id)
    )`,

    `CREATE TABLE IF NOT EXISTS ${T.user_database_permissions} (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES ${T.users}(id) ON DELETE CASCADE,
      database_id TEXT NOT NULL REFERENCES ${T.d1_databases}(id) ON DELETE CASCADE,
      permission TEXT NOT NULL DEFAULT 'read' CHECK (permission IN ('read', 'write')),
      granted_by TEXT REFERENCES ${T.users}(id),
      granted_at INTEGER NOT NULL,
      UNIQUE (user_id, database_id)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_${T.user_database_permissions}_user ON ${T.user_database_permissions}(user_id)`,
    `CREATE INDEX IF NOT EXISTS idx_${T.user_database_permissions}_db   ON ${T.user_database_permissions}(database_id)`,

    `CREATE TABLE IF NOT EXISTS ${T.query_history} (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES ${T.users}(id),
      database_id TEXT NOT NULL REFERENCES ${T.d1_databases}(id),
      sql TEXT NOT NULL,
      duration_ms INTEGER,
      row_count INTEGER,
      error TEXT,
      executed_at INTEGER NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_${T.query_history}_user ON ${T.query_history}(user_id)`,
    `CREATE INDEX IF NOT EXISTS idx_${T.query_history}_db   ON ${T.query_history}(database_id)`,

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
      updated_at INTEGER NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_${T.notebooks}_user ON ${T.notebooks}(user_id)`,
  ]
}

// Default settings (INSERT OR IGNORE so re-runs are safe)
const DEFAULT_SETTINGS: Array<[string, string]> = [
  ['registration_enabled', 'true'],
  ['require_email_verification', 'false'],
  ['enforce_2fa', 'false'],
  ['email_provider', 'resend'],
  ['resend_api_key', ''],
  ['smtp_host', ''],
  ['smtp_port', '587'],
  ['smtp_user', ''],
  ['smtp_pass', ''],
  ['smtp_from', ''],
  ['app_name', 'Zeta'],
  ['setup_completed', 'true'],
]

// ── GET /api/setup/:secret ────────────────────────────────────────────────────

setup.get('/:secret', async (c) => {
  const secret = c.req.param('secret')
  const expected = c.env.SETUP_SECRET

  // SETUP_SECRET must be set; reject if missing or mismatched
  if (!expected || expected.trim() === '') {
    return c.json({ error: 'SETUP_SECRET is not configured on this Worker.' }, 500)
  }
  if (secret !== expected) {
    return c.json({ error: 'Invalid setup secret.' }, 403)
  }

  const T = tables(c.env)
  const errors: string[] = []
  const ts = now()

  // Run all DDL statements in a batch
  try {
    await c.env.DB.batch(buildDDL(T).map((stmt) => c.env.DB.prepare(stmt)))
  } catch (err) {
    errors.push(`DDL error: ${err instanceof Error ? err.message : String(err)}`)
  }

  // Seed default settings (INSERT OR IGNORE)
  if (errors.length === 0) {
    try {
      await c.env.DB.batch(
        DEFAULT_SETTINGS.map(([key, value]) =>
          c.env.DB.prepare(
            `INSERT OR IGNORE INTO ${T.settings} (key, value, updated_at) VALUES (?1, ?2, ?3)`
          ).bind(key, value, ts)
        )
      )
    } catch (err) {
      errors.push(`Settings seed error: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  if (errors.length > 0) {
    return c.json({ ok: false, errors }, 500)
  }

  return c.json({
    ok: true,
    message: 'Database initialised successfully. You can now register at /register — the first user becomes admin.',
  })
})

export default setup
