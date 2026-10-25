import type { Env } from '../types'
import { now, tablePrefix, tables } from './db'
import { type MigrationResult, runMigrations, TablePrefixConflictError } from './migrations-runner'

// The reusable schema-initialisation routine, shared by POST /api/setup (keyed to SETUP_SECRET,
// rate-limited) and POST /api/admin/setup (keyed to the admin session). Both return the same result
// shape; the caller maps `ok: false` to a 500.
//
// The schema itself is applied by the shared ledger runner (lib/migrations-runner.ts): the
// versioned list in lib/migrations.ts is the single source of truth, the runner records what it
// applied in the `_<prefix>_schema_migrations` ledger and skips it on later runs. This module only
// maps that run to the response and seeds the default settings.

export type SetupResult =
  | {
      ok: true
      message: string
      // The table prefix actually in effect: DEFAULT_TABLE_PREFIX + '_' when TABLE_PREFIX is
      // unset, the configured value + '_' (e.g. 'ZETA_'), or '' for an unprefixed deployment.
      tablePrefix: string
      // Every migration of this run, in order, with its outcome.
      migrations: MigrationResult[]
      // Human-readable lines for the migrations applied by this run (absent when all were already
      // applied — same shape as before the ledger, which the setup pages render as "Database
      // upgraded:"). Kept for the existing front end; `permissionsRepair` is gone with the PRAGMA
      // upgrades that produced it (nothing ever read it).
      upgraded?: string[]
    }
  | { ok: false; errors: string[] }

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

// Applies every pending schema migration, then seeds the default settings. Returns the effective
// prefix, each migration's outcome and, for compatibility with the setup pages, the readable list
// of migrations this run applied.
export async function runSetup(env: Env): Promise<SetupResult> {
  const prefix = tablePrefix(env)

  let run: Awaited<ReturnType<typeof runMigrations>>
  try {
    run = await runMigrations(env)
  } catch (err) {
    if (err instanceof TablePrefixConflictError) return { ok: false, errors: [err.message] }
    return { ok: false, errors: [`Migration error: ${err instanceof Error ? err.message : String(err)}`] }
  }

  // Seed default settings (INSERT OR IGNORE). A setup step rather than a migration: the settings a
  // deployment starts with are an application decision, and the values already in the table (an
  // admin's choices) must never be touched.
  const T = tables(env)
  const ts = now()
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
    return { ok: false, errors: [`Settings seed error: ${err instanceof Error ? err.message : String(err)}`] }
  }

  const upgraded = run.migrations.filter((migration) => migration.status === 'applied').map((m) => `${m.name}: applied`)

  return {
    ok: true,
    message:
      'Database initialised successfully. You can now register at /register — the first user becomes admin. ' +
      'On new installs registration then stays closed until an admin opens it in Admin → Settings. ' +
      `Tables use the prefix ${prefix === '' ? '(none)' : prefix}.`,
    tablePrefix: run.prefix,
    migrations: run.migrations,
    ...(upgraded.length > 0 && { upgraded }),
  }
}
