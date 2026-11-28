import type { Context } from 'hono'
import { Hono } from 'hono'
import { capAppDbPermission } from '../lib/app-db-guard'
import { isAppDb } from '../lib/d1-http'
import { audit, now, tables } from '../lib/db'
import { effectiveProvider } from '../lib/provider'
import { openSecret } from '../lib/secrets'
import type { SparkAccess } from '../lib/spark-access'
import { checkDatabaseHasSparkUi, checkHasLivy, normalizeSparkAccess } from '../lib/spark-access'
import type { JarRef } from '../lib/spark-config'
import { validateInstanceEntries, validateInstanceJars } from '../lib/spark-config'
import { applySparkConfig, fetchSparkConfigStatus, fetchSparkJars, SparkQueryError } from '../lib/spark-executor'
import type { Permission } from '../lib/sql-guard'
import { requireAuth } from '../middleware/auth'
import type { DatabaseRow, Env, Variables } from '../types'

const databases = new Hono<{ Bindings: Env; Variables: Variables }>()
databases.use('*', requireAuth)

// ── GET /api/databases ────────────────────────────────────────────────────────

databases.get('/', async (c) => {
  const userId = c.get('userId')
  const role = c.get('userRole')
  const T = tables(c.env)

  let rows: DatabaseRow[]

  if (role === 'admin') {
    const result = await c.env.DB.prepare(
      `SELECT * FROM ${T.d1_databases} WHERE is_active = 1 ORDER BY name`
    ).all<DatabaseRow>()
    rows = result.results
  } else {
    const result = await c.env.DB.prepare(
      `SELECT d.* FROM ${T.d1_databases} d
       JOIN ${T.user_database_permissions} p ON p.database_id = d.id
       WHERE p.user_id = ?1 AND d.is_active = 1
       ORDER BY d.name`
    )
      .bind(userId)
      .all<DatabaseRow>()
    rows = result.results
  }

  // Annotate with user's permission level
  let permMap = new Map<string, string>()
  if (role !== 'admin') {
    const perms = await c.env.DB.prepare(
      `SELECT database_id, permission FROM ${T.user_database_permissions} WHERE user_id = ?1`
    )
      .bind(userId)
      .all<{ database_id: string; permission: string }>()
    permMap = new Map(perms.results.map((r) => [r.database_id, r.permission]))
  }

  return c.json(
    await Promise.all(
      rows.map(async (db) => {
        const appDb = isAppDb(c.env, db.cf_database_id)
        // The application database's permission is capped at write: the admin's implicit manage
        // and any stored write_drop/manage are reported at their effective level, never above write.
        const base: Permission = role === 'admin' ? 'manage' : ((permMap.get(db.id) ?? 'read') as Permission)
        const kind = db.kind ?? 'sqlite'
        const has_spark_ui = await checkDatabaseHasSparkUi(c.env, db)
        const has_livy = await checkHasLivy(c.env, db)
        return {
          id: db.id,
          name: db.name,
          description: db.description,
          kind,
          // `provider` is the label to show (the registration's own, or the engine's), `provider_custom`
          // the text it is editing — see lib/provider.ts.
          provider: effectiveProvider(kind, db.provider),
          provider_custom: db.provider ?? null,
          ...(role === 'admin' ? { binding_name: db.binding_name, cf_database_id: db.cf_database_id } : {}),
          is_app_db: appDb,
          permission: appDb ? capAppDbPermission(base) : base,
          has_spark_ui,
          has_livy,
        }
      })
    )
  )
})

// ── Spark instance configuration (SPEC §6) ────────────────────────────────────
// The expected config lives in spark_instance_configs (one row per Spark target, schema_v7); the
// service's effective state is never stored — GET passes the service's §1.2 status through
// unchanged and degrades to "unknown" (null) when the service cannot be reached. §4: only a global
// admin or an exact `manage` grant may read, save or apply the instance config (`write_drop` does
// not include it).

type Ctx = Context<{ Bindings: Env; Variables: Variables }>

// The caller's address for the audit trail, with the same fallback the other write paths use.
function clientIp(c: Ctx): string {
  return c.req.header('cf-connecting-ip') ?? 'unknown'
}

// Resolves the target and the caller's right to manage it. Returns an error response, or null with
// the registry row when the caller is an admin or holds an exact `manage` grant on it.
async function resolveSparkInstance(c: Ctx, id: string): Promise<{ db: DatabaseRow } | Response> {
  const T = tables(c.env)
  const db = await c.env.DB.prepare(`SELECT * FROM ${T.d1_databases} WHERE id = ?1 AND is_active = 1`)
    .bind(id)
    .first<DatabaseRow>()
  if (!db) return c.json({ error: 'Database not found' }, 404)
  if (db.kind !== 'spark') {
    return c.json({ error: 'Instance configuration is only available for Spark databases.' }, 400)
  }
  if (c.get('userRole') !== 'admin') {
    const perm = await c.env.DB.prepare(
      `SELECT permission FROM ${T.user_database_permissions} WHERE user_id = ?1 AND database_id = ?2`
    )
      .bind(c.get('userId'), db.id)
      .first<{ permission: string }>()
    if (perm?.permission !== 'manage') return c.json({ error: 'Access denied' }, 403)
  }
  return { db }
}

// The decrypted Spark access of a registry row, or null when the stored payload is missing or
// unreadable (a changed ENCRYPTION_KEY, a hand-edited row). GET degrades on null; apply reports it.
async function sparkAccessOrNull(env: Env, db: DatabaseRow): Promise<SparkAccess | null> {
  if (!db.connection_secret) return null
  try {
    const stored = await openSecret(env, db.connection_secret)
    const normalized = normalizeSparkAccess(JSON.parse(stored))
    return normalized.ok ? normalized.access : null
  } catch (err) {
    console.error(`Stored Spark connection could not be read: ${err instanceof Error ? err.name : typeof err}`)
    return null
  }
}

// The stored expected config, defaulting to empty. A corrupt JSON blob reads as empty on purpose:
// this code is the only writer, so a corrupt row is a deployment artifact, never a caller's mistake.
async function readInstanceConfig(
  env: Env,
  databaseId: string
): Promise<{ entries: Record<string, string>; jars: JarRef[] }> {
  const T = tables(env)
  const row = await env.DB.prepare(`SELECT entries, jars FROM ${T.spark_instance_configs} WHERE database_id = ?1`)
    .bind(databaseId)
    .first<{ entries: string; jars: string }>()
  if (!row) return { entries: {}, jars: [] }

  let entries: Record<string, string> = {}
  let jars: JarRef[] = []
  try {
    const e: unknown = JSON.parse(row.entries)
    if (e && typeof e === 'object' && !Array.isArray(e)) entries = e as Record<string, string>
  } catch {
    entries = {}
  }
  try {
    const j: unknown = JSON.parse(row.jars)
    if (Array.isArray(j)) jars = j as JarRef[]
  } catch {
    jars = []
  }
  return { entries, jars }
}

// GET /api/databases/:id/spark-instance-config — the expected config plus the service's current
// status and jar listing, each null when the service cannot be reached ("status unknown").
databases.get('/:id/spark-instance-config', async (c) => {
  const resolved = await resolveSparkInstance(c, c.req.param('id'))
  if (resolved instanceof Response) return resolved

  const expected = await readInstanceConfig(c.env, resolved.db.id)
  const access = await sparkAccessOrNull(c.env, resolved.db)
  const [status, serverJars] = access
    ? await Promise.all([fetchSparkConfigStatus(access), fetchSparkJars(access)])
    : [null, null]

  return c.json({ entries: expected.entries, jars: expected.jars, status, serverJars })
})

// PUT /api/databases/:id/spark-instance-config — validates and stores the expected config only;
// it never touches the service.
databases.put('/:id/spark-instance-config', async (c) => {
  const resolved = await resolveSparkInstance(c, c.req.param('id'))
  if (resolved instanceof Response) return resolved

  const body = await c.req.json<{ entries?: unknown; jars?: unknown }>().catch(() => null)
  if (
    !body ||
    typeof body !== 'object' ||
    Array.isArray(body) ||
    body.entries === undefined ||
    body.jars === undefined
  ) {
    return c.json({ error: 'entries and jars are required' }, 400)
  }

  const entries = validateInstanceEntries(body.entries)
  if (!entries.ok) return c.json({ error: entries.error }, 400)
  const jars = validateInstanceJars(body.jars)
  if (!jars.ok) return c.json({ error: jars.error }, 400)

  const T = tables(c.env)
  const userId = c.get('userId')
  const ts = now()
  await c.env.DB.prepare(
    `INSERT INTO ${T.spark_instance_configs} (database_id, entries, jars, updated_by, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5)
     ON CONFLICT(database_id) DO UPDATE SET entries = ?2, jars = ?3, updated_by = ?4, updated_at = ?5`
  )
    .bind(resolved.db.id, JSON.stringify(entries.value), JSON.stringify(jars.value), userId, ts)
    .run()

  c.executionCtx.waitUntil(
    audit(c.env, {
      userId,
      action: 'spark_instance_config_save',
      resource: resolved.db.id,
      ip: clientIp(c),
      userAgent: c.req.header('user-agent'),
    })
  )

  return c.json({ entries: entries.value, jars: jars.value })
})

// POST /api/databases/:id/spark-instance-config/apply — applies the stored expected config via the
// service's §1.2 apply. A service rejection (400) is surfaced as its own sentence; anything else is
// "service unreachable" and never a configuration error.
databases.post('/:id/spark-instance-config/apply', async (c) => {
  const resolved = await resolveSparkInstance(c, c.req.param('id'))
  if (resolved instanceof Response) return resolved

  const access = await sparkAccessOrNull(c.env, resolved.db)
  if (!access) return c.json({ error: 'The stored connection for this database could not be read.' }, 500)

  const expected = await readInstanceConfig(c.env, resolved.db.id)
  // `running` is a started apply too: the service took the config without needing a restart, and the
  // UI learns the terminal state by polling the status (§6.1) — it must never read as unreachable.
  let state: 'running' | 'draining' | 'restarting'
  try {
    state = await applySparkConfig(access, { entries: expected.entries, jars: expected.jars })
  } catch (err) {
    if (err instanceof SparkQueryError && err.kind === 'sql') {
      return c.json({ error: err.message }, 400)
    }
    console.error(`Spark config apply failed: ${err instanceof Error ? err.message : String(err)}`)
    return c.json({ error: 'The Spark service could not be reached.' }, 502)
  }

  c.executionCtx.waitUntil(
    audit(c.env, {
      userId: c.get('userId'),
      action: 'spark_instance_config_apply',
      resource: resolved.db.id,
      ip: clientIp(c),
      userAgent: c.req.header('user-agent'),
    })
  )

  return c.json({ state }, 202)
})

export default databases
