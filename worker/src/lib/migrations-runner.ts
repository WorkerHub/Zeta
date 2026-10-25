import type { Env } from '../types'
import { detectExistingMigrationLedgers, detectExistingTableFamily, migrationsTable, tablePrefix, tables } from './db'
import { getMigrations, type Migration } from './migrations'

// ── Ledger-based migration runner ────────────────────────────────────────────────────────────
// Both schema entry points delegate here: the secret-keyed POST /api/setup and the admin-session
// POST /api/admin/setup both call runSetup() (lib/setup.ts), which applies the DDL through
// runMigrations(). The schema is therefore applied by exactly one code path, shared by both.

export interface MigrationResult {
  name: string
  status: 'applied' | 'skipped'
}

export interface RunMigrationsResult {
  // The effective table prefix ('' when the deployer explicitly configured no prefix).
  prefix: string
  migrations: MigrationResult[]
}

// Thrown when the database already holds an initialised Zeta schema under a different prefix than
// the one resolved from the environment: migrating would silently switch the app to a different
// (usually empty) set of tables.
export class TablePrefixConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TablePrefixConflictError'
  }
}

const showPrefix = (prefix: string) => (prefix === '' ? '(no prefix)' : prefix)

// Names the TABLE_PREFIX that keeps the tables already in the database.
function keepPrefixHint(prefix: string): string {
  return prefix === ''
    ? 'set TABLE_PREFIX to an empty string (TABLE_PREFIX="") to keep using these unprefixed tables'
    : `set TABLE_PREFIX=${prefix.slice(0, -1)} to keep using these tables`
}

// Returns a human-readable description of a conflicting already-initialised schema, or null when
// the database is safe to migrate under the resolved prefix. Read-only: never writes.
async function detectSchemaConflict(
  env: Pick<Env, 'DB' | 'TABLE_PREFIX'>,
  checkConsistency: boolean
): Promise<string | null> {
  const prefix = tablePrefix(env)
  const [family, ledgers] = await Promise.all([
    detectExistingTableFamily(env.DB),
    detectExistingMigrationLedgers(env.DB),
  ])
  const ledgerFor = (p: string) => ledgers.find((ledger) => ledger.prefix === p)

  // 1. A Zeta business-table family under another prefix (the primary signal, unchanged from the
  //    pre-ledger guard): e.g. a deployment that used TABLE_PREFIX=ZETA losing the variable would
  //    otherwise start a fresh zeta_* set and strand its data.
  if (family !== null && family.prefix !== prefix) {
    const ledger = ledgerFor(family.prefix)
    return (
      `Refusing to initialise: this D1 database already contains an initialised Zeta schema with ` +
      `table prefix ${showPrefix(family.prefix)} (${family.tableCount} tables), but the resolved table ` +
      `prefix is ${showPrefix(prefix)}. ${keepPrefixHint(family.prefix)} (or point the Worker at a ` +
      `different D1 database) and run setup again. Initialising under a different prefix would ` +
      `strand the existing data.` +
      (ledger === undefined ? '' : ` Its applied migrations are recorded in ${ledger.table}.`)
    )
  }

  // 2. A ledger table is a second, independent signal — but `_<prefix>_schema_migrations` is a
  //    fleet-wide convention shared with the other projects in the same D1 database (SL_*, nav_*,
  //    post_*, …), so a ledger on its own does not prove the schema is Zeta's. A bare foreign
  //    ledger therefore never blocks a first install; only the resolved prefix's own ledger is
  //    interpreted, and only once it actually records a migration.
  const resolvedLedger = ledgerFor(prefix)
  const expectedTables = Object.values(tables(env)).length
  const incompleteSchema = family === null || family.tableCount < expectedTables
  if (checkConsistency && resolvedLedger !== undefined && incompleteSchema) {
    const recorded = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${resolvedLedger.table}`).first<{ n: number }>()
    // An empty ledger is harmless (e.g. left behind by a run whose DDL failed): the migrations are
    // simply applied again, and every statement is IF NOT EXISTS.
    if ((recorded?.n ?? 0) > 0) {
      const found =
        family === null ? 'none of its tables are' : `only ${family.tableCount} of ${expectedTables} tables are`
      return (
        `Refusing to initialise: the migration ledger ${resolvedLedger.table} records that the Zeta ` +
        `schema migrations were already applied, but ${found} present. Running setup again would skip ` +
        `every recorded migration and leave an incomplete schema. If the tables were dropped on ` +
        `purpose, drop ${resolvedLedger.table} as well and run setup again to re-initialise from ` +
        `scratch; otherwise restore the missing tables.`
      )
    }
  }

  return null
}

// Placeholder for a string literal while the SQL is collapsed onto one line: a private-use
// character, which no migration SQL contains.
const LITERAL_SENTINEL = '\uE000'

// D1's exec() only processes the first line of a multi-line string, so a migration's SQL is
// collapsed onto one line before it runs. String literals are left untouched (whitespace inside
// them is significant) and SQL line comments are dropped — a `--` comment would otherwise comment
// out everything after it once the newlines are gone.
function toSingleLine(sql: string): string {
  const literals: string[] = []
  const withoutComments = sql.replace(/'(?:[^']|'')*'|--[^\n]*/g, (match) => {
    if (match.startsWith('--')) return ''
    literals.push(match)
    return `${LITERAL_SENTINEL}${literals.length - 1}${LITERAL_SENTINEL}`
  })
  // Odd indexes of the split are the literal placeholders put in above
  return withoutComments
    .replace(/\s+/g, ' ')
    .trim()
    .split(LITERAL_SENTINEL)
    .map((part, index) => (index % 2 === 1 ? literals[Number(part)]! : part))
    .join('')
}

// Applies every migration not yet recorded in the ledger table, stopping at the first failure. A
// migration is recorded only after its SQL succeeded, so a failed run leaves that migration
// unrecorded and the following ones unexecuted; the caller reports the thrown error instead of
// returning a partial success.
//
// `migrations` is injectable for tests only; production always uses getMigrations(env) — the single
// source of truth for the schema.
export async function runMigrations(
  env: Pick<Env, 'DB' | 'TABLE_PREFIX'>,
  migrations?: Migration[]
): Promise<RunMigrationsResult> {
  const prefix = tablePrefix(env)

  // Anti-silent-switch guard, before any DDL. The ledger/table consistency check (rule 2) only
  // applies to the production schema list: an injected list defines some other schema, whose tables
  // the Zeta family check cannot judge.
  const conflict = await detectSchemaConflict(env, migrations === undefined)
  if (conflict !== null) throw new TablePrefixConflictError(conflict)

  const ledger = migrationsTable(env)
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS ${ledger} (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL DEFAULT (unixepoch()))`
  ).run()

  const applied = new Set(
    (await env.DB.prepare(`SELECT name FROM ${ledger}`).all<{ name: string }>()).results.map((row) => row.name)
  )

  const results: MigrationResult[] = []
  for (const migration of migrations ?? getMigrations(env)) {
    if (applied.has(migration.name)) {
      results.push({ name: migration.name, status: 'skipped' })
      continue
    }
    try {
      await env.DB.exec(toSingleLine(migration.sql))
      await env.DB.prepare(`INSERT INTO ${ledger} (name) VALUES (?1)`).bind(migration.name).run()
      results.push({ name: migration.name, status: 'applied' })
    } catch (err) {
      throw new Error(
        `Migration ${migration.name} failed and was not recorded: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  return { prefix, migrations: results }
}
