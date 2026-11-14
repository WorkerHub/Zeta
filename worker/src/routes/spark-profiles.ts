import { type Context, Hono } from 'hono'
import { now, tables } from '../lib/db'
import { uuid } from '../lib/id'
import {
  MAX_PROFILES_PER_DB,
  type ProfileEntriesResult,
  type ProfileEntry,
  parseStoredEntries,
  validateProfileEntries,
} from '../lib/spark-profile'
import { requireAuth } from '../middleware/auth'
import type { Env, SparkConfigProfileRow, Variables } from '../types'

// ── Personal Spark config profiles (SPEC §5.1/§5.2/§4) ────────────────────────────────────────
// Mounted at /api/databases (see index.ts), so these routes serve /api/databases/:id/spark-profiles.
// A profile is one user's saved runtime Spark SQLConf entries for one Spark target. Only the owner
// sees or changes them (every read and write is filtered by user_id); anyone with ≥ read access to
// a Spark target may manage their own profiles (§4).

const sparkProfiles = new Hono<{ Bindings: Env; Variables: Variables }>()
sparkProfiles.use('*', requireAuth)

type Ctx = Context<{ Bindings: Env; Variables: Variables }>

// The database id once the target is a Spark database the caller can use — the same access rule as
// the query paths (an admin, or a stored permission row), and a non-Spark target is refused.
async function resolveSparkDatabase(c: Ctx, databaseId: string): Promise<Response | string> {
  const T = tables(c.env)
  const db = await c.env.DB.prepare(`SELECT kind FROM ${T.d1_databases} WHERE id = ?1 AND is_active = 1`)
    .bind(databaseId)
    .first<{ kind: string | null }>()
  if (!db) return c.json({ error: 'Database not found' }, 404)
  if (c.get('userRole') !== 'admin') {
    const perm = await c.env.DB.prepare(
      `SELECT 1 FROM ${T.user_database_permissions} WHERE user_id = ?1 AND database_id = ?2`
    )
      .bind(c.get('userId'), databaseId)
      .first()
    if (!perm) return c.json({ error: 'Access denied' }, 403)
  }
  if ((db.kind ?? 'sqlite') !== 'spark') {
    return c.json({ error: 'Spark profiles are only available for SparkSQL databases' }, 400)
  }
  return databaseId
}

// Whether the caller already has a profile of this name on this target. `excludeId` keeps a rename
// from colliding with the very profile being renamed.
async function nameTaken(
  c: Ctx,
  databaseId: string,
  userId: string,
  name: string,
  excludeId?: string
): Promise<boolean> {
  const T = tables(c.env)
  const stmt = excludeId
    ? c.env.DB.prepare(
        `SELECT 1 FROM ${T.spark_config_profiles} WHERE user_id = ?1 AND database_id = ?2 AND name = ?3 AND id != ?4`
      ).bind(userId, databaseId, name, excludeId)
    : c.env.DB.prepare(
        `SELECT 1 FROM ${T.spark_config_profiles} WHERE user_id = ?1 AND database_id = ?2 AND name = ?3`
      ).bind(userId, databaseId, name)
  return (await stmt.first()) !== null
}

const profileDto = (row: SparkConfigProfileRow) => ({
  id: row.id,
  name: row.name,
  entries: parseStoredEntries(row.entries),
  updated_at: row.updated_at,
})

// A save-time validation failure: the code matches the service's §1.1 answer, so the UI maps the two
// the same way and points at the offending key (or the name, for a name conflict).
function entriesError(c: Ctx, result: ProfileEntriesResult & { ok: false }): Response {
  if (result.kind === 'limit') return c.json({ error: result.error }, 400)
  return c.json(
    {
      error:
        result.code === 'startup_key_in_profile'
          ? 'This parameter is startup-level; change it in the instance configuration.'
          : 'Invalid Spark configuration key or value.',
      code: result.code,
      key: result.key,
    },
    400
  )
}

sparkProfiles.get('/:id/spark-profiles', async (c) => {
  const databaseId = await resolveSparkDatabase(c, c.req.param('id'))
  if (databaseId instanceof Response) return databaseId
  const T = tables(c.env)
  const rows = await c.env.DB.prepare(
    `SELECT * FROM ${T.spark_config_profiles} WHERE user_id = ?1 AND database_id = ?2 ORDER BY updated_at DESC`
  )
    .bind(c.get('userId'), databaseId)
    .all<SparkConfigProfileRow>()
  return c.json({ results: rows.results.map(profileDto) })
})

sparkProfiles.post('/:id/spark-profiles', async (c) => {
  const databaseId = await resolveSparkDatabase(c, c.req.param('id'))
  if (databaseId instanceof Response) return databaseId

  const body = await c.req.json<{ name?: unknown; entries?: unknown }>().catch(() => null)
  if (!body) return c.json({ error: 'Invalid body' }, 400)
  const name = typeof body.name === 'string' ? body.name.trim() : ''
  if (!name) return c.json({ error: 'name is required' }, 400)
  if (name.length > 200) return c.json({ error: 'name is too long' }, 400)

  const validated = validateProfileEntries(body.entries)
  if (!validated.ok) return entriesError(c, validated)

  const userId = c.get('userId')
  const T = tables(c.env)
  // §3: at most 20 profiles per (user × data source).
  const count = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM ${T.spark_config_profiles} WHERE user_id = ?1 AND database_id = ?2`
  )
    .bind(userId, databaseId)
    .first<{ n: number }>()
  if ((count?.n ?? 0) >= MAX_PROFILES_PER_DB) {
    return c.json({ error: `Maximum ${MAX_PROFILES_PER_DB} profiles per database` }, 400)
  }
  if (await nameTaken(c, databaseId, userId, name)) {
    return c.json({ error: `A profile named "${name}" already exists`, name }, 400)
  }

  const id = uuid()
  const ts = now()
  await c.env.DB.prepare(
    `INSERT INTO ${T.spark_config_profiles} (id, user_id, database_id, name, entries, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)`
  )
    .bind(id, userId, databaseId, name, JSON.stringify(validated.entries), ts)
    .run()

  return c.json({ id, name, entries: validated.entries, updated_at: ts }, 201)
})

sparkProfiles.put('/:id/spark-profiles/:pid', async (c) => {
  const databaseId = await resolveSparkDatabase(c, c.req.param('id'))
  if (databaseId instanceof Response) return databaseId

  const userId = c.get('userId')
  const T = tables(c.env)
  const existing = await c.env.DB.prepare(
    `SELECT id FROM ${T.spark_config_profiles} WHERE id = ?1 AND user_id = ?2 AND database_id = ?3`
  )
    .bind(c.req.param('pid'), userId, databaseId)
    .first()
  if (!existing) return c.json({ error: 'Profile not found' }, 404)

  const body = await c.req.json<{ name?: unknown; entries?: unknown }>().catch(() => null)
  if (!body) return c.json({ error: 'Invalid body' }, 400)

  let name: string | undefined
  if (body.name !== undefined) {
    const trimmed = typeof body.name === 'string' ? body.name.trim() : ''
    if (!trimmed) return c.json({ error: 'name cannot be empty' }, 400)
    if (trimmed.length > 200) return c.json({ error: 'name is too long' }, 400)
    name = trimmed
  }

  let entries: ProfileEntry[] | undefined
  if (body.entries !== undefined) {
    const validated = validateProfileEntries(body.entries)
    if (!validated.ok) return entriesError(c, validated)
    entries = validated.entries
  }

  if (name === undefined && entries === undefined) return c.json({ error: 'No fields to update' }, 400)

  if (name !== undefined && (await nameTaken(c, databaseId, userId, name, c.req.param('pid')))) {
    return c.json({ error: `A profile named "${name}" already exists`, name }, 400)
  }

  const ts = now()
  const updates: string[] = ['updated_at = ?1']
  const bindings: unknown[] = [ts]
  let idx = 2
  if (name !== undefined) {
    updates.push(`name = ?${idx++}`)
    bindings.push(name)
  }
  if (entries !== undefined) {
    updates.push(`entries = ?${idx++}`)
    bindings.push(JSON.stringify(entries))
  }
  bindings.push(c.req.param('pid'), userId, databaseId)

  await c.env.DB.prepare(
    `UPDATE ${T.spark_config_profiles} SET ${updates.join(', ')} WHERE id = ?${idx} AND user_id = ?${idx + 1} AND database_id = ?${idx + 2}`
  )
    .bind(...bindings)
    .run()
  return c.json({ message: 'Updated' })
})

sparkProfiles.delete('/:id/spark-profiles/:pid', async (c) => {
  const databaseId = await resolveSparkDatabase(c, c.req.param('id'))
  if (databaseId instanceof Response) return databaseId

  const T = tables(c.env)
  const res = await c.env.DB.prepare(
    `DELETE FROM ${T.spark_config_profiles} WHERE id = ?1 AND user_id = ?2 AND database_id = ?3`
  )
    .bind(c.req.param('pid'), c.get('userId'), databaseId)
    .run()
  if (!res.meta.changes) return c.json({ error: 'Profile not found' }, 404)
  return c.json({ message: 'Deleted' })
})

export default sparkProfiles
