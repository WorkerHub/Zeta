import type { D1Database } from '@cloudflare/workers-types'
import type { Env } from '../types'
import { detectExistingTableFamily, now, tablePrefix, tables } from './db'
import type { ExistingTableFamily } from './db'

// The reusable schema-initialisation + upgrade routine, shared by POST /api/setup (keyed to
// SETUP_SECRET, rate-limited) and POST /api/admin/setup (keyed to the admin session). Both return
// the same result shape; the caller maps `ok: false` to a 500.

export type SetupResult =
  | {
      ok: true
      message: string
      // The table prefix actually in effect: DEFAULT_TABLE_PREFIX + '_' when TABLE_PREFIX is
      // unset, the configured value + '_' (e.g. 'ZETA_'), or '' for an unprefixed deployment.
      tablePrefix: string
      upgraded?: string[]
      permissionsRepair?: { dropped: number; clearedGrantedBy: number }
    }
  | { ok: false; errors: string[] }

// ── DDL builder (idempotent – all use IF NOT EXISTS) ──────────────────────────

// user_id / database_id are nullable (and nulled by the database itself) so history survives
// deleting a user or database.
function historyTableDDL(T: ReturnType<typeof tables>, name: string): string {
  return `CREATE TABLE IF NOT EXISTS ${name} (
      id TEXT PRIMARY KEY,
      user_id TEXT REFERENCES ${T.users}(id) ON DELETE SET NULL,
      database_id TEXT REFERENCES ${T.d1_databases}(id) ON DELETE SET NULL,
      sql TEXT NOT NULL,
      duration_ms INTEGER,
      row_count INTEGER,
      error TEXT,
      executed_at INTEGER NOT NULL
    )`
}

function historyIndexDDL(T: ReturnType<typeof tables>): string[] {
  return [
    `CREATE INDEX IF NOT EXISTS idx_${T.query_history}_user ON ${T.query_history}(user_id)`,
    `CREATE INDEX IF NOT EXISTS idx_${T.query_history}_db   ON ${T.query_history}(database_id)`,
    `CREATE INDEX IF NOT EXISTS idx_${T.query_history}_executed ON ${T.query_history}(executed_at)`,
  ]
}

// Databases initialised by older versions have NOT NULL history refs, which makes deleting a
// user or database fail now that their history rows are kept with NULL refs, and their refs
// lack ON DELETE SET NULL. SQLite cannot alter either in place, so rebuild the table once (same
// change as migrations/0002 + 0003, but prefix-aware and usable on deployments that were set up
// through this endpoint).
const HISTORY_REFS = ['user_id', 'database_id']

async function upgradeHistoryTable(db: D1Database, T: ReturnType<typeof tables>): Promise<boolean> {
  const [cols, fks] = await Promise.all([
    db.prepare(`PRAGMA table_info(${T.query_history})`).all<{ name: string; notnull: number }>(),
    db.prepare(`PRAGMA foreign_key_list(${T.query_history})`).all<{ from: string; on_delete: string }>(),
  ])
  const strict = cols.results.some((col) => HISTORY_REFS.includes(col.name) && col.notnull)
  const noSetNull = fks.results.some((fk) => HISTORY_REFS.includes(fk.from) && fk.on_delete !== 'SET NULL')
  if (!strict && !noSetNull) return false

  const tmp = `${T.query_history}_new`
  const columns = 'id, user_id, database_id, sql, duration_ms, row_count, error, executed_at'
  await db.batch(
    [
      `DROP TABLE IF EXISTS ${tmp}`,
      historyTableDDL(T, tmp),
      `INSERT INTO ${tmp} (${columns}) SELECT ${columns} FROM ${T.query_history}`,
      `DROP TABLE ${T.query_history}`,
      `ALTER TABLE ${tmp} RENAME TO ${T.query_history}`,
      ...historyIndexDDL(T),
    ].map((stmt) => db.prepare(stmt))
  )
  return true
}

function permissionsTableDDL(T: ReturnType<typeof tables>, name: string): string {
  return `CREATE TABLE IF NOT EXISTS ${name} (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES ${T.users}(id) ON DELETE CASCADE,
      database_id TEXT NOT NULL REFERENCES ${T.d1_databases}(id) ON DELETE CASCADE,
      permission TEXT NOT NULL DEFAULT 'read' CHECK (permission IN ('read', 'write', 'write_drop')),
      granted_by TEXT REFERENCES ${T.users}(id),
      granted_at INTEGER NOT NULL,
      UNIQUE (user_id, database_id)
    )`
}

function permissionsIndexDDL(T: ReturnType<typeof tables>): string[] {
  return [
    `CREATE INDEX IF NOT EXISTS idx_${T.user_database_permissions}_user ON ${T.user_database_permissions}(user_id)`,
    `CREATE INDEX IF NOT EXISTS idx_${T.user_database_permissions}_db   ON ${T.user_database_permissions}(database_id)`,
  ]
}

// Indexes migrations/0001 put on the permissions table. They are dropped only when they belong to
// that table: in a database shared with other projects the same names may index something else.
const LEGACY_PERMISSION_INDEXES = ['idx_perm_user', 'idx_perm_db']

// Some prefixed deployments ended up with a permissions table whose foreign keys still point at
// the unprefixed `users` / `d1_databases` tables. With foreign keys enforced, every INSERT or
// DELETE on it then fails ("no such table: main.d1_databases") and nothing cascades from the real
// tables. SQLite cannot repoint a foreign key in place, so rebuild the table in one batch (all or
// nothing), keeping only rows whose user and database still exist. Returns null when the foreign
// keys are already right, otherwise how many rows were dropped / lost their granted_by.
async function repairPermissionRefs(
  db: D1Database,
  T: ReturnType<typeof tables>
): Promise<{ dropped: number; clearedGrantedBy: number } | null> {
  const expected: Record<string, string> = { user_id: T.users, database_id: T.d1_databases, granted_by: T.users }
  const fks = await db
    .prepare(`PRAGMA foreign_key_list(${T.user_database_permissions})`)
    .all<{ from: string; table: string }>()
  const misdirected = fks.results.some((fk) => {
    const target = expected[fk.from]
    return target !== undefined && fk.table.toLowerCase() !== target.toLowerCase()
  })
  if (!misdirected) return null

  const legacyIndexes = await db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ?1 COLLATE NOCASE
       AND name IN (${LEGACY_PERMISSION_INDEXES.map((_, i) => `?${i + 2}`).join(', ')})`
    )
    .bind(T.user_database_permissions, ...LEGACY_PERMISSION_INDEXES)
    .all<{ name: string }>()

  const old = T.user_database_permissions
  const tmp = `${old}_new`
  const userExists = (col: string) => `EXISTS (SELECT 1 FROM ${T.users} u WHERE u.id = p.${col})`
  const kept = `${userExists('user_id')} AND EXISTS (SELECT 1 FROM ${T.d1_databases} d WHERE d.id = p.database_id)`
  const results = await db.batch<{ n: number }>(
    [
      `SELECT COUNT(*) AS n FROM ${old} p WHERE NOT (${kept})`,
      `SELECT COUNT(*) AS n FROM ${old} p WHERE ${kept} AND p.granted_by IS NOT NULL AND NOT ${userExists('granted_by')}`,
      ...legacyIndexes.results.map((idx) => `DROP INDEX IF EXISTS ${idx.name}`),
      `DROP TABLE IF EXISTS ${tmp}`,
      permissionsTableDDL(T, tmp),
      `INSERT INTO ${tmp} (id, user_id, database_id, permission, granted_by, granted_at)
       SELECT p.id, p.user_id, p.database_id, p.permission,
              CASE WHEN ${userExists('granted_by')} THEN p.granted_by END, p.granted_at
       FROM ${old} p WHERE ${kept}`,
      `DROP TABLE ${old}`,
      `ALTER TABLE ${tmp} RENAME TO ${old}`,
      ...permissionsIndexDDL(T),
    ].map((stmt) => db.prepare(stmt))
  )
  return { dropped: results[0]?.results[0]?.n ?? 0, clearedGrantedBy: results[1]?.results[0]?.n ?? 0 }
}

// users.notebook_run_limit (a user's own, lower run limit) was added after the first release;
// CREATE TABLE IF NOT EXISTS leaves older users tables without it.
async function addUserRunLimitColumn(db: D1Database, T: ReturnType<typeof tables>): Promise<boolean> {
  const cols = await db.prepare(`PRAGMA table_info(${T.users})`).all<{ name: string }>()
  if (cols.results.some((col) => col.name === 'notebook_run_limit')) return false
  await db.prepare(`ALTER TABLE ${T.users} ADD COLUMN notebook_run_limit INTEGER`).run()
  return true
}

// d1_databases.cf_database_id was added when query targets moved to the D1 HTTP API; older tables
// lack it and cannot be queried until an admin re-links each database. This only adds the column
// (the binding → UUID mapping cannot be recovered at runtime, so the rows are re-linked from the
// admin UI).
async function addCfDatabaseIdColumn(db: D1Database, T: ReturnType<typeof tables>): Promise<boolean> {
  const cols = await db.prepare(`PRAGMA table_info(${T.d1_databases})`).all<{ name: string }>()
  if (cols.results.some((col) => col.name === 'cf_database_id')) return false
  await db.prepare(`ALTER TABLE ${T.d1_databases} ADD COLUMN cf_database_id TEXT`).run()
  return true
}

// Run numbers (notebook_runs.seq, the counter notebooks.last_run_seq) were added after saved runs
// first shipped; same change as migrations/0005. Adds the missing columns, numbers the runs that
// have no number yet (oldest first, after the notebook's highest number, so re-runs only touch
// stragglers) and makes sure the unique (notebook_id, seq) index exists, all in one batch.
// Returns a description of what changed, or null when nothing needed numbering.
async function numberRuns(db: D1Database, T: ReturnType<typeof tables>): Promise<string | null> {
  const R = T.notebook_runs
  const N = T.notebooks
  const [runCols, notebookCols] = await Promise.all([
    db.prepare(`PRAGMA table_info(${R})`).all<{ name: string }>(),
    db.prepare(`PRAGMA table_info(${N})`).all<{ name: string }>(),
  ])
  const addSeq = !runCols.results.some((col) => col.name === 'seq')
  const addCounter = !notebookCols.results.some((col) => col.name === 'last_run_seq')
  const unnumbered = addSeq
    ? 0
    : ((await db.prepare(`SELECT COUNT(*) AS n FROM ${R} WHERE seq IS NULL`).first<{ n: number }>())?.n ?? 0)

  const stmts: string[] = []
  if (addSeq) stmts.push(`ALTER TABLE ${R} ADD COLUMN seq INTEGER`)
  if (addCounter) stmts.push(`ALTER TABLE ${N} ADD COLUMN last_run_seq INTEGER NOT NULL DEFAULT 0`)
  let backfill = -1
  if (addSeq || addCounter || unnumbered > 0) {
    // The counter is brought up to the highest number first, so unnumbered runs continue after it
    const syncCounter = `UPDATE ${N} SET last_run_seq = MAX(last_run_seq,
      (SELECT COALESCE(MAX(seq), 0) FROM ${R} WHERE ${R}.notebook_id = ${N}.id))`
    stmts.push(syncCounter)
    backfill = stmts.length
    stmts.push(
      `UPDATE ${R} SET seq = numbered.seq
       FROM (
         SELECT r.id, n.last_run_seq + ROW_NUMBER() OVER (PARTITION BY r.notebook_id ORDER BY r.executed_at, r.id) AS seq
         FROM ${R} r JOIN ${N} n ON n.id = r.notebook_id
         WHERE r.seq IS NULL
       ) AS numbered
       WHERE ${R}.id = numbered.id`,
      syncCounter
    )
  }
  stmts.push(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_${R}_seq ON ${R}(notebook_id, seq)`,
    // Replaced by the index above: the run list and per-notebook pruning order by seq now
    `DROP INDEX IF EXISTS idx_${R}_notebook`
  )
  const results = await db.batch(stmts.map((stmt) => db.prepare(stmt)))

  if (backfill === -1) return null
  const numbered = results[backfill]?.meta.changes ?? 0
  const added = [addSeq && `seq`, addCounter && `${N}.last_run_seq`].filter(Boolean)
  if (added.length === 0 && numbered === 0) return null
  return `${R}: ${added.length > 0 ? `added ${added.join(', ')}; ` : ''}numbered ${numbered} saved run(s)`
}

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

    permissionsTableDDL(T, T.user_database_permissions),
    ...permissionsIndexDDL(T),

    historyTableDDL(T, T.query_history),
    ...historyIndexDDL(T),

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
    // columns never touch its overflow pages; the user index covers the storage-quota pruning. The
    // (notebook_id, seq) index is created by numberRuns, after older tables have gained `seq`.
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

    // Atomic rate-limit counters (see lib/auth.ts)
    `CREATE TABLE IF NOT EXISTS ${T.rate_limits} (
      key TEXT PRIMARY KEY,
      count INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_${T.rate_limits}_expires ON ${T.rate_limits}(expires_at)`,
  ]
}

// Default settings (INSERT OR IGNORE so re-runs are safe). Registration starts closed: the first
// account can still be created (it becomes the admin), everyone else needs an admin to open
// registration or create their account. Email verification and enforced 2FA stay off because no
// email provider is configured yet, and turning them on now would lock every user out.
const DEFAULT_SETTINGS: Array<[string, string]> = [
  ['registration_enabled', 'false'],
  ['require_email_verification', 'false'],
  ['enforce_2fa', 'false'],
  ['email_provider', 'resend'],
  ['app_name', 'Zeta'],
  ['notebook_run_limit', '100'],
  ['run_storage_quota_mb', '50'],
]

// Creates every table (idempotently), applies schema upgrades for databases created by older
// versions, and seeds the default settings. Returns the same shape POST /api/setup has always
// returned (`ok`, `message`, `upgraded`, `permissionsRepair`) plus `tablePrefix` — the prefix
// actually in effect — so both callers stay byte-compatible.
export async function runSetup(env: Env): Promise<SetupResult> {
  const T = tables(env)
  const prefix = tablePrefix(env)
  const errors: string[] = []
  const ts = now()

  // Anti-silent-switch guard, before any DDL: if this D1 database already holds an initialised
  // Zeta schema under a DIFFERENT prefix than the resolved one, initialising here would strand
  // that data behind a brand-new set of tables (a silent switch — e.g. a deployment that used to
  // run TABLE_PREFIX=ZETA losing the variable would suddenly point at zeta_*). Refuse and tell
  // the operator which TABLE_PREFIX keeps the existing tables. A database that hosts no complete
  // Zeta family — including one shared with other projects' tables — initialises normally.
  let existing: ExistingTableFamily | null
  try {
    existing = await detectExistingTableFamily(env.DB)
  } catch (err) {
    return { ok: false, errors: [`Schema inspection error: ${err instanceof Error ? err.message : String(err)}`] }
  }
  if (existing && existing.prefix !== prefix) {
    const show = (p: string) => (p === '' ? '(no prefix)' : p)
    const hint =
      existing.prefix === ''
        ? 'set TABLE_PREFIX to an empty string (TABLE_PREFIX="") to keep using these unprefixed tables'
        : `set TABLE_PREFIX=${existing.prefix.slice(0, -1)} to keep using these tables`
    return {
      ok: false,
      errors: [
        `Refusing to initialise: this D1 database already contains an initialised Zeta schema with ` +
          `table prefix ${show(existing.prefix)} (${existing.tableCount} tables), but the resolved table ` +
          `prefix is ${show(prefix)}. ${hint} (or point the Worker at a different D1 database) and run ` +
          `setup again. Initialising under a different prefix would strand the existing data.`,
      ],
    }
  }

  // Run all DDL statements in a batch
  try {
    await env.DB.batch(buildDDL(T).map((stmt) => env.DB.prepare(stmt)))
  } catch (err) {
    errors.push(`DDL error: ${err instanceof Error ? err.message : String(err)}`)
  }

  // Schema upgrades for databases created by older versions
  const upgraded: string[] = []
  let permissionsRepair: { dropped: number; clearedGrantedBy: number } | null = null
  if (errors.length === 0) {
    try {
      if (await upgradeHistoryTable(env.DB, T)) {
        upgraded.push(`${T.query_history}: nullable user_id/database_id with ON DELETE SET NULL`)
      }
      if (await addUserRunLimitColumn(env.DB, T)) {
        upgraded.push(`${T.users}: added notebook_run_limit`)
      }
      if (await addCfDatabaseIdColumn(env.DB, T)) {
        upgraded.push(`${T.d1_databases}: added cf_database_id`)
      }
      const runNumbers = await numberRuns(env.DB, T)
      if (runNumbers) upgraded.push(runNumbers)
      permissionsRepair = await repairPermissionRefs(env.DB, T)
      if (permissionsRepair) {
        upgraded.push(
          `${T.user_database_permissions}: foreign keys now reference ${T.users}/${T.d1_databases} ` +
            `(dropped ${permissionsRepair.dropped} orphaned row(s), ` +
            `cleared granted_by on ${permissionsRepair.clearedGrantedBy} row(s))`
        )
      }
    } catch (err) {
      errors.push(`Upgrade error: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // Seed default settings (INSERT OR IGNORE)
  if (errors.length === 0) {
    try {
      await env.DB.batch(
        DEFAULT_SETTINGS.map(([key, value]) =>
          env.DB.prepare(`INSERT OR IGNORE INTO ${T.settings} (key, value, updated_at) VALUES (?1, ?2, ?3)`).bind(
            key,
            value,
            ts
          )
        )
      )
    } catch (err) {
      errors.push(`Settings seed error: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors }
  }

  return {
    ok: true,
    message:
      'Database initialised successfully. You can now register at /register — the first user becomes admin. ' +
      'On new installs registration then stays closed until an admin opens it in Admin → Settings. ' +
      `Tables use the prefix ${prefix === '' ? '(none)' : prefix}.`,
    tablePrefix: prefix,
    ...(upgraded.length > 0 && { upgraded }),
    ...(permissionsRepair && { permissionsRepair }),
  }
}
