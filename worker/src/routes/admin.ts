import { Hono, type Context } from 'hono'
import type { Env, Variables, UserRow, DatabaseRow } from '../types'
import { requireAdmin } from '../middleware/auth'
import { uuid } from '../lib/id'
import { now, setSetting, getSettings, audit, tables } from '../lib/db'
import { hashPassword, checkRateLimit } from '../lib/auth'
import { KV } from '../lib/kv'
import { sealSecret, sealLegacySecret } from '../lib/secrets'
import { listAccountD1Databases, D1HttpError, appDbId, type CfD1Database } from '../lib/d1-http'
import { sendEmail, isValidEmail } from '../lib/email'
import { MAX_RUN_LIMIT, MAX_RUN_QUOTA_MB, parseBoundedInt, pruneRuns } from '../lib/runs'

const admin = new Hono<{ Bindings: Env; Variables: Variables }>()
admin.use('*', requireAdmin)

// ── Users ─────────────────────────────────────────────────────────────────────

admin.get('/users', async (c) => {
  const limit = Math.min(Math.max(parseInt(c.req.query('limit') ?? '50', 10) || 50, 1), 200)
  const offset = Math.max(parseInt(c.req.query('offset') ?? '0', 10) || 0, 0)
  const search = c.req.query('search')?.trim()
  const T = tables(c.env)

  let rows: D1Result<Omit<UserRow, 'password_hash' | 'updated_at'>>
  let total: { n: number } | null
  if (search) {
    const like = `%${search.replace(/[%_\\]/g, '\\$&')}%`
    rows = await c.env.DB.prepare(
      `SELECT id, email, name, role, email_verified, two_factor_required, created_at
       FROM ${T.users} WHERE email LIKE ?1 ESCAPE '\\' OR name LIKE ?1 ESCAPE '\\'
       ORDER BY created_at DESC LIMIT ?2 OFFSET ?3`
    )
      .bind(like, limit, offset)
      .all<Omit<UserRow, 'password_hash' | 'updated_at'>>()
    total = await c.env.DB.prepare(
      `SELECT COUNT(*) as n FROM ${T.users} WHERE email LIKE ?1 ESCAPE '\\' OR name LIKE ?1 ESCAPE '\\'`
    )
      .bind(like)
      .first<{ n: number }>()
  } else {
    rows = await c.env.DB.prepare(
      `SELECT id, email, name, role, email_verified, two_factor_required, created_at
       FROM ${T.users} ORDER BY created_at DESC LIMIT ?1 OFFSET ?2`
    )
      .bind(limit, offset)
      .all<Omit<UserRow, 'password_hash' | 'updated_at'>>()
    total = await c.env.DB.prepare(`SELECT COUNT(*) as n FROM ${T.users}`).first<{ n: number }>()
  }

  return c.json({ results: rows.results, total: total?.n ?? 0 })
})

admin.get('/users/:id', async (c) => {
  const T = tables(c.env)
  const user = await c.env.DB.prepare(
    `SELECT id, email, name, role, email_verified, two_factor_required, created_at FROM ${T.users} WHERE id = ?1`
  )
    .bind(c.req.param('id'))
    .first<Omit<UserRow, 'password_hash' | 'updated_at'>>()
  if (!user) return c.json({ error: 'User not found' }, 404)

  const perms = await c.env.DB.prepare(
    `SELECT p.*, d.name as database_name FROM ${T.user_database_permissions} p
     JOIN ${T.d1_databases} d ON d.id = p.database_id WHERE p.user_id = ?1`
  )
    .bind(user.id)
    .all()

  return c.json({ ...user, permissions: perms.results })
})

admin.post('/users', async (c) => {
  const body = await c.req.json<{ name?: string; email?: string; password?: string; role?: string }>().catch(() => null)
  if (!body?.name?.trim() || !body.email?.trim() || !body.password) {
    return c.json({ error: 'name, email and password are required' }, 400)
  }
  if (!['admin', 'member'].includes(body.role ?? 'member')) {
    return c.json({ error: 'Invalid role' }, 400)
  }
  if (body.password.length < 8) {
    return c.json({ error: 'Password must be at least 8 characters' }, 400)
  }
  const T = tables(c.env)
  const email = body.email.trim().toLowerCase()
  const existing = await c.env.DB.prepare(`SELECT id FROM ${T.users} WHERE email = ?1`).bind(email).first()
  if (existing) return c.json({ error: 'Email already in use' }, 409)

  const id = uuid()
  const passwordHash = await hashPassword(body.password)
  await c.env.DB.prepare(
    `INSERT INTO ${T.users} (id, email, name, role, password_hash, email_verified, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6, ?6)`
  )
    .bind(id, email, body.name.trim(), body.role ?? 'member', passwordHash, now())
    .run()

  c.executionCtx.waitUntil(
    audit(c.env, {
      userId: c.get('userId'),
      action: 'create_user',
      resource: id,
      ip: c.req.header('cf-connecting-ip'),
    })
  )
  return c.json({ id }, 201)
})

admin.patch('/users/:id', async (c) => {
  const body = await c.req
    .json<{
      role?: string
      two_factor_required?: boolean
      name?: string
      email?: string
      password?: string
    }>()
    .catch(() => null)
  if (!body) return c.json({ error: 'Invalid body' }, 400)

  const updates: string[] = []
  const bindings: unknown[] = []
  let i = 1

  if (body.role !== undefined) {
    if (!['admin', 'member'].includes(body.role)) return c.json({ error: 'Invalid role' }, 400)
    if (body.role === 'member') {
      const T2 = tables(c.env)
      const adminCount = await c.env.DB.prepare(`SELECT COUNT(*) as n FROM ${T2.users} WHERE role = 'admin'`).first<{
        n: number
      }>()
      const currentUser = await c.env.DB.prepare(`SELECT role FROM ${T2.users} WHERE id = ?1`)
        .bind(c.req.param('id'))
        .first<{ role: string }>()
      if (currentUser?.role === 'admin' && (adminCount?.n ?? 0) <= 1) {
        return c.json({ error: 'Cannot demote the last admin' }, 400)
      }
    }
    updates.push(`role = ?${i++}`)
    bindings.push(body.role)
  }
  if (body.two_factor_required !== undefined) {
    updates.push(`two_factor_required = ?${i++}`)
    bindings.push(body.two_factor_required ? 1 : 0)
  }
  if (body.name !== undefined) {
    if (!body.name.trim()) return c.json({ error: 'Name cannot be empty' }, 400)
    updates.push(`name = ?${i++}`)
    bindings.push(body.name.trim())
  }
  if (body.email !== undefined) {
    if (!body.email.trim()) return c.json({ error: 'Email cannot be empty' }, 400)
    const email = body.email.trim().toLowerCase()
    const T2 = tables(c.env)
    const conflict = await c.env.DB.prepare(`SELECT id FROM ${T2.users} WHERE email = ?1 AND id != ?2`)
      .bind(email, c.req.param('id'))
      .first()
    if (conflict) return c.json({ error: 'Email already in use' }, 409)
    updates.push(`email = ?${i++}`)
    bindings.push(email)
    updates.push(`email_verified = ?${i++}`)
    bindings.push(0)
  }
  if (body.password !== undefined && body.password !== '') {
    if (body.password.length < 8) return c.json({ error: 'Password must be at least 8 characters' }, 400)
    const hash = await hashPassword(body.password)
    updates.push(`password_hash = ?${i++}`)
    bindings.push(hash)
  }

  if (updates.length === 0) return c.json({ error: 'Nothing to update' }, 400)

  updates.push(`updated_at = ?${i++}`)
  bindings.push(now())
  bindings.push(c.req.param('id'))

  const T = tables(c.env)
  await c.env.DB.prepare(`UPDATE ${T.users} SET ${updates.join(', ')} WHERE id = ?${i}`)
    .bind(...bindings)
    .run()

  if ((body.password !== undefined && body.password !== '') || body.role !== undefined || body.email !== undefined) {
    await c.env.KV.put(KV.sessionInvalidatedAt(c.req.param('id')), String(now()), { expirationTtl: 7 * 24 * 3600 })
  }

  c.executionCtx.waitUntil(
    audit(c.env, {
      userId: c.get('userId'),
      action: 'update_user',
      resource: c.req.param('id'),
      ip: c.req.header('cf-connecting-ip'),
    })
  )
  return c.json({ message: 'User updated' })
})

admin.delete('/users/:id', async (c) => {
  const id = c.req.param('id')
  if (id === c.get('userId')) return c.json({ error: 'Cannot delete yourself' }, 400)
  const T = tables(c.env)
  const target = await c.env.DB.prepare(`SELECT role FROM ${T.users} WHERE id = ?1`).bind(id).first<{ role: string }>()
  if (!target) return c.json({ error: 'User not found' }, 404)
  if (target.role === 'admin') {
    const adminCount = await c.env.DB.prepare(`SELECT COUNT(*) as n FROM ${T.users} WHERE role = 'admin'`).first<{
      n: number
    }>()
    if ((adminCount?.n ?? 0) <= 1) return c.json({ error: 'Cannot delete the last admin' }, 400)
  }
  // D1 enforces foreign keys, but older schemas lack ON DELETE actions on some refs (and
  // TABLE_PREFIX deployments may predate them) — delete/nullify all references explicitly
  await c.env.DB.batch([
    c.env.DB.prepare(`DELETE FROM ${T.totp_credentials} WHERE user_id = ?1`).bind(id),
    c.env.DB.prepare(`DELETE FROM ${T.passkey_credentials} WHERE user_id = ?1`).bind(id),
    c.env.DB.prepare(`DELETE FROM ${T.notebook_runs} WHERE user_id = ?1`).bind(id),
    c.env.DB.prepare(`DELETE FROM ${T.notebooks} WHERE user_id = ?1`).bind(id),
    c.env.DB.prepare(`UPDATE ${T.query_history} SET user_id = NULL WHERE user_id = ?1`).bind(id),
    c.env.DB.prepare(`DELETE FROM ${T.user_database_permissions} WHERE user_id = ?1`).bind(id),
    c.env.DB.prepare(`UPDATE ${T.user_database_permissions} SET granted_by = NULL WHERE granted_by = ?1`).bind(id),
    c.env.DB.prepare(`UPDATE ${T.audit_logs} SET user_id = NULL WHERE user_id = ?1`).bind(id),
    c.env.DB.prepare(`UPDATE ${T.d1_databases} SET created_by = NULL WHERE created_by = ?1`).bind(id),
    c.env.DB.prepare(`DELETE FROM ${T.users} WHERE id = ?1`).bind(id),
  ])
  await c.env.KV.put(KV.sessionInvalidatedAt(id), String(now()), { expirationTtl: 7 * 24 * 3600 })
  c.executionCtx.waitUntil(
    audit(c.env, {
      userId: c.get('userId'),
      action: 'delete_user',
      resource: id,
      ip: c.req.header('cf-connecting-ip'),
    })
  )
  return c.json({ message: 'User deleted' })
})

// ── Database registry ─────────────────────────────────────────────────────────

// Maps a D1 HTTP API error to an admin-facing response. These routes are admin-only, so the full
// detail (missing credential, invalid token, rate limit) is shown verbatim.
function d1Error(c: Context<{ Bindings: Env; Variables: Variables }>, err: unknown) {
  if (err instanceof D1HttpError) return c.json({ error: err.message }, err.status as 400)
  return c.json({ error: err instanceof Error ? err.message : String(err) }, 500)
}

// A database that predates the cf_database_id column (POST /api/setup not re-run after upgrading)
// fails the registry statements with "no such column". Point the admin at the fix instead of
// leaking the raw D1 error.
const MISSING_CF_COLUMN = /no such column: cf_database_id/i
function missingColumnResponse(c: Context<{ Bindings: Env; Variables: Variables }>, err: unknown): Response | null {
  if (err instanceof Error && MISSING_CF_COLUMN.test(err.message)) {
    return c.json({ error: 'The database registry needs an upgrade. Re-run POST /api/setup.' }, 500)
  }
  return null
}

// Verifies a picked database uuid is a real account database and not the application's own.
async function verifyCfDatabase(
  c: Context<{ Bindings: Env; Variables: Variables }>,
  cfDatabaseId: string
): Promise<Response | { name: string }> {
  const appId = appDbId(c.env)
  if (appId && cfDatabaseId === appId) {
    return c.json({ error: 'The application database cannot be added as a query target.' }, 400)
  }
  let available: CfD1Database[]
  try {
    available = await listAccountD1Databases(c.env)
  } catch (err) {
    return d1Error(c, err)
  }
  const cf = available.find((d) => d.uuid === cfDatabaseId)
  if (!cf) return c.json({ error: 'Database not found in this Cloudflare account.' }, 404)
  return { name: cf.name }
}

admin.get('/databases', async (c) => {
  const T = tables(c.env)
  const rows = await c.env.DB.prepare(`SELECT * FROM ${T.d1_databases} ORDER BY name`).all<DatabaseRow>()
  return c.json({ results: rows.results })
})

// The Cloudflare account's D1 databases (minus the app DB), each annotated with whether it is
// already registered as a query target and, if so, the registry row's id.
admin.get('/d1/databases', async (c) => {
  let available: CfD1Database[]
  try {
    available = await listAccountD1Databases(c.env)
  } catch (err) {
    return d1Error(c, err)
  }
  const T = tables(c.env)
  let rows: D1Result<{ id: string; cf_database_id: string }>
  try {
    rows = await c.env.DB.prepare(
      `SELECT id, cf_database_id FROM ${T.d1_databases} WHERE cf_database_id IS NOT NULL`
    ).all<{
      id: string
      cf_database_id: string
    }>()
  } catch (err) {
    const missing = missingColumnResponse(c, err)
    if (missing) return missing
    throw err
  }
  const added = new Map(rows.results.map((r) => [r.cf_database_id, r.id]))
  return c.json({
    results: available.map((d) => ({
      uuid: d.uuid,
      name: d.name,
      created_at: d.created_at,
      added: added.has(d.uuid),
      database_id: added.get(d.uuid) ?? null,
    })),
  })
})

admin.post('/databases', async (c) => {
  const body = await c.req
    .json<{
      name?: string
      description?: string
      cf_database_id?: string
    }>()
    .catch(() => null)
  if (typeof body?.cf_database_id !== 'string' || !body.cf_database_id) {
    return c.json({ error: 'cf_database_id is required' }, 400)
  }
  if (!/^[0-9a-fA-F-]{36}$/.test(body.cf_database_id)) {
    return c.json({ error: 'Invalid cf_database_id' }, 400)
  }

  // Verify the database exists in the account and is not the application's own database
  const verified = await verifyCfDatabase(c, body.cf_database_id)
  if (verified instanceof Response) return verified

  const T = tables(c.env)
  try {
    const dup = await c.env.DB.prepare(`SELECT id FROM ${T.d1_databases} WHERE cf_database_id = ?1`)
      .bind(body.cf_database_id)
      .first()
    if (dup) return c.json({ error: 'This database is already registered' }, 409)

    const id = uuid()
    await c.env.DB.prepare(
      `INSERT INTO ${T.d1_databases} (id, name, description, binding_name, cf_database_id, is_active, created_at, created_by)
       VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6, ?7)`
    )
      .bind(
        id,
        body.name?.trim() || verified.name,
        body.description ?? null,
        `cf:${body.cf_database_id}`,
        body.cf_database_id,
        now(),
        c.get('userId')
      )
      .run()

    c.executionCtx.waitUntil(
      audit(c.env, {
        userId: c.get('userId'),
        action: 'create_database',
        resource: id,
        ip: c.req.header('cf-connecting-ip'),
      })
    )
    return c.json({ id }, 201)
  } catch (err) {
    const missing = missingColumnResponse(c, err)
    if (missing) return missing
    throw err
  }
})

admin.patch('/databases/:id', async (c) => {
  const body = await c.req
    .json<{ name?: string; description?: string; is_active?: boolean; cf_database_id?: string }>()
    .catch(() => null)
  if (!body) return c.json({ error: 'Invalid body' }, 400)

  const updates: string[] = []
  const bindings: unknown[] = []
  let i = 1

  if (body.cf_database_id !== undefined) {
    if (typeof body.cf_database_id !== 'string' || !/^[0-9a-fA-F-]{36}$/.test(body.cf_database_id)) {
      return c.json({ error: 'Invalid cf_database_id' }, 400)
    }
    // Re-linking a legacy row to a real account database (migration): verify it and refuse the app DB
    const verified = await verifyCfDatabase(c, body.cf_database_id)
    if (verified instanceof Response) return verified

    const T2 = tables(c.env)
    try {
      const dup = await c.env.DB.prepare(`SELECT id FROM ${T2.d1_databases} WHERE cf_database_id = ?1 AND id != ?2`)
        .bind(body.cf_database_id, c.req.param('id'))
        .first()
      if (dup) return c.json({ error: 'This database is already registered' }, 409)
    } catch (err) {
      const missing = missingColumnResponse(c, err)
      if (missing) return missing
      throw err
    }

    updates.push(`cf_database_id = ?${i++}`)
    bindings.push(body.cf_database_id)
  }
  if (body.name) {
    updates.push(`name = ?${i++}`)
    bindings.push(body.name)
  }
  if (body.description !== undefined) {
    updates.push(`description = ?${i++}`)
    bindings.push(body.description)
  }
  if (body.is_active !== undefined) {
    updates.push(`is_active = ?${i++}`)
    bindings.push(body.is_active ? 1 : 0)
  }

  if (updates.length === 0) return c.json({ error: 'Nothing to update' }, 400)
  bindings.push(c.req.param('id'))

  const T = tables(c.env)
  try {
    await c.env.DB.prepare(`UPDATE ${T.d1_databases} SET ${updates.join(', ')} WHERE id = ?${i}`)
      .bind(...bindings)
      .run()
  } catch (err) {
    const missing = missingColumnResponse(c, err)
    if (missing) return missing
    throw err
  }

  c.executionCtx.waitUntil(
    audit(c.env, {
      userId: c.get('userId'),
      action: 'update_database',
      resource: c.req.param('id'),
      ip: c.req.header('cf-connecting-ip'),
    })
  )
  return c.json({ message: 'Updated' })
})

admin.delete('/databases/:id', async (c) => {
  const T = tables(c.env)
  const dbId = c.req.param('id')

  const exists = await c.env.DB.prepare(`SELECT id FROM ${T.d1_databases} WHERE id = ?1`)
    .bind(dbId)
    .first<{ id: string }>()
  if (!exists) return c.json({ error: 'Database not found' }, 404)

  await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE ${T.notebooks} SET database_id = NULL WHERE database_id = ?1`).bind(dbId),
    c.env.DB.prepare(`DELETE FROM ${T.notebook_runs} WHERE database_id = ?1`).bind(dbId),
    c.env.DB.prepare(`DELETE FROM ${T.user_database_permissions} WHERE database_id = ?1`).bind(dbId),
    c.env.DB.prepare(`UPDATE ${T.query_history} SET database_id = NULL WHERE database_id = ?1`).bind(dbId),
    c.env.DB.prepare(`DELETE FROM ${T.d1_databases} WHERE id = ?1`).bind(dbId),
  ])
  c.executionCtx.waitUntil(
    audit(c.env, {
      userId: c.get('userId'),
      action: 'delete_database',
      resource: dbId,
      ip: c.req.header('cf-connecting-ip'),
    })
  )
  return c.json({ message: 'Deleted' })
})

// ── Permissions ───────────────────────────────────────────────────────────────

admin.get('/databases/:id/permissions', async (c) => {
  const T = tables(c.env)
  const rows = await c.env.DB.prepare(
    `SELECT p.*, u.email, u.name as user_name
     FROM ${T.user_database_permissions} p JOIN ${T.users} u ON u.id = p.user_id
     WHERE p.database_id = ?1`
  )
    .bind(c.req.param('id'))
    .all()
  return c.json({ results: rows.results })
})

admin.put('/databases/:id/permissions/:userId', async (c) => {
  const body = await c.req.json<{ permission?: string }>().catch(() => null)
  if (!body?.permission || !['read', 'write', 'write_drop'].includes(body.permission)) {
    return c.json({ error: 'permission must be "read", "write", or "write_drop"' }, 400)
  }

  const T = tables(c.env)
  await c.env.DB.prepare(
    `INSERT INTO ${T.user_database_permissions} (id, user_id, database_id, permission, granted_by, granted_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6)
     ON CONFLICT(user_id, database_id) DO UPDATE SET permission = ?4, granted_by = ?5, granted_at = ?6`
  )
    .bind(uuid(), c.req.param('userId'), c.req.param('id'), body.permission, c.get('userId'), now())
    .run()

  c.executionCtx.waitUntil(
    audit(c.env, {
      userId: c.get('userId'),
      action: 'set_permission',
      resource: c.req.param('id'),
      metadata: { targetUser: c.req.param('userId'), permission: body.permission },
      ip: c.req.header('cf-connecting-ip'),
    })
  )
  return c.json({ message: 'Permission set' })
})

admin.delete('/databases/:id/permissions/:userId', async (c) => {
  const T = tables(c.env)
  // The user's saved results from this database go with the access to it
  await c.env.DB.batch([
    c.env.DB.prepare(`DELETE FROM ${T.user_database_permissions} WHERE user_id = ?1 AND database_id = ?2`).bind(
      c.req.param('userId'),
      c.req.param('id')
    ),
    c.env.DB.prepare(`DELETE FROM ${T.notebook_runs} WHERE user_id = ?1 AND database_id = ?2`).bind(
      c.req.param('userId'),
      c.req.param('id')
    ),
  ])
  c.executionCtx.waitUntil(
    audit(c.env, {
      userId: c.get('userId'),
      action: 'revoke_permission',
      resource: c.req.param('id'),
      metadata: { targetUser: c.req.param('userId') },
      ip: c.req.header('cf-connecting-ip'),
    })
  )
  return c.json({ message: 'Permission revoked' })
})

// ── Settings ──────────────────────────────────────────────────────────────────

const SECRET_MASK = '••••••'

const EXPOSED_SETTINGS = [
  'registration_enabled',
  'require_email_verification',
  'enforce_2fa',
  'email_provider',
  'smtp_config',
  'resend_config',
  'app_name',
  'notebook_run_limit',
  'run_storage_quota_mb',
  'setup_page_enabled',
]

admin.get('/settings', async (c) => {
  const cfg = await getSettings(c.env, EXPOSED_SETTINGS)
  // The setup-page toggle defaults to enabled on deployments that predate it (its row is absent).
  if (cfg.setup_page_enabled === undefined) cfg.setup_page_enabled = '1'
  // Opportunistically encrypt secrets still stored as plaintext by older versions
  for (const [key, field] of [
    ['smtp_config', 'password'],
    ['resend_config', 'api_key'],
  ] as const) {
    const raw = cfg[key]
    if (raw) c.executionCtx.waitUntil(sealLegacySecret(c.env, key, raw, field).catch(() => false))
  }
  // Mask secrets in JSON blobs
  if (cfg.smtp_config) {
    try {
      const smtp = JSON.parse(cfg.smtp_config)
      if (smtp.password) smtp.password = SECRET_MASK
      cfg.smtp_config = JSON.stringify(smtp)
    } catch {
      /* ignore malformed */
    }
  }
  if (cfg.resend_config) {
    try {
      const resend = JSON.parse(cfg.resend_config)
      if (resend.api_key) resend.api_key = SECRET_MASK
      cfg.resend_config = JSON.stringify(resend)
    } catch {
      /* ignore malformed */
    }
  }
  return c.json(cfg)
})

const BOOLEAN_SETTINGS = new Set(['registration_enabled', 'require_email_verification', 'enforce_2fa'])
// Settings whose values are stored as '0' / '1' (on/off) rather than 'true' / 'false'.
const ENUM_SETTINGS: Record<string, readonly string[]> = { setup_page_enabled: ['0', '1'] }
// Limits on saved notebook runs (see lib/runs.ts): integer ranges
const RUN_SETTINGS: Record<string, number> = {
  notebook_run_limit: MAX_RUN_LIMIT,
  run_storage_quota_mb: MAX_RUN_QUOTA_MB,
}
const VALID_EMAIL_PROVIDERS = ['none', 'resend', 'smtp']

admin.patch('/settings', async (c) => {
  const body = await c.req.json<Record<string, string>>().catch(() => null)
  if (!body) return c.json({ error: 'Invalid body' }, 400)

  // Reject a malformed sender up front (before anything is saved) rather than skipping it
  // silently: it ends up in the SMTP envelope and headers.
  for (const key of ['smtp_config', 'resend_config']) {
    if (body[key] === undefined) continue
    let from: unknown
    try {
      from = (JSON.parse(String(body[key])) as { from?: unknown } | null)?.from
    } catch {
      continue
    }
    if (from !== undefined && from !== '' && (typeof from !== 'string' || !isValidEmail(from))) {
      return c.json({ error: 'Invalid from address' }, 400)
    }
  }

  for (const [key, max] of Object.entries(RUN_SETTINGS)) {
    if (body[key] !== undefined && parseBoundedInt(String(body[key]), 1, max) === null) {
      return c.json({ error: `Invalid ${key}` }, 400)
    }
  }

  const allowed = new Set(EXPOSED_SETTINGS)
  const existingSettings = await getSettings(c.env, EXPOSED_SETTINGS)
  let runLimitsChanged = false

  for (const [key, value] of Object.entries(body)) {
    if (!allowed.has(key)) continue

    const v = String(value)
    if (BOOLEAN_SETTINGS.has(key) && v !== 'true' && v !== 'false') continue
    const enumValues = ENUM_SETTINGS[key]
    if (enumValues && !enumValues.includes(v)) continue
    if (key === 'email_provider' && !VALID_EMAIL_PROVIDERS.includes(v)) continue
    if (key in RUN_SETTINGS) {
      const n = String(parseBoundedInt(v, 1, RUN_SETTINGS[key]!))
      if (existingSettings[key] !== n) runLimitsChanged = true
      await setSetting(c.env, key, n)
      continue
    }

    if (key === 'smtp_config' || key === 'resend_config') {
      const secretField = key === 'smtp_config' ? 'password' : 'api_key'
      let newConfig: Record<string, unknown>
      try {
        newConfig = JSON.parse(v)
      } catch {
        continue
      }
      if (typeof newConfig !== 'object' || newConfig === null || Array.isArray(newConfig)) continue
      // An omitted or masked secret means "keep the stored one" (never persist the placeholder);
      // an explicit empty string clears it.
      const secret = newConfig[secretField]
      if (secret === undefined || secret === null || secret === SECRET_MASK) {
        let existing: Record<string, unknown> = {}
        try {
          existing = existingSettings[key] ? JSON.parse(existingSettings[key]) : {}
        } catch {
          /* */
        }
        newConfig[secretField] = existing[secretField] || ''
      } else if (typeof secret !== 'string') {
        continue
      }
      // Encrypt at rest; also upgrades legacy plaintext values the next time settings are saved.
      if (typeof newConfig[secretField] === 'string') {
        newConfig[secretField] = await sealSecret(c.env, newConfig[secretField] as string)
      }
      await setSetting(c.env, key, JSON.stringify(newConfig))
    } else {
      await setSetting(c.env, key, v)
    }
  }

  // Lower limits apply to the runs already stored right away
  if (runLimitsChanged) c.executionCtx.waitUntil(pruneRuns(c.env))
  c.executionCtx.waitUntil(
    audit(c.env, {
      userId: c.get('userId'),
      action: 'update_settings',
      ip: c.req.header('cf-connecting-ip'),
    })
  )
  return c.json({ message: 'Settings saved' })
})

// ── Test email ─────────────────────────────────────────────────────────────────

admin.post('/settings/test-email', async (c) => {
  const body = await c.req.json<{ to?: unknown }>().catch(() => null)
  const to = body?.to
  if (typeof to !== 'string' || !isValidEmail(to)) return c.json({ error: 'Invalid email address' }, 400)

  // Sends to arbitrary recipients, so a stolen admin session must not turn it into a mail relay
  if (!(await checkRateLimit(c.env, KV.testEmailAttempts(c.get('userId')), 5, 15 * 60))) {
    return c.json({ error: 'Too many test emails. Try again later.' }, 429)
  }

  const result = await sendEmail(c.env, {
    to,
    subject: 'Zeta Test Email',
    html: '<p>This is a test email from Zeta. Your email configuration is working correctly.</p>',
    text: 'This is a test email from Zeta. Your email configuration is working correctly.',
  })

  if (!result.success) {
    return c.json({ error: result.error || 'Failed to send email' }, 500)
  }

  return c.json({ success: true })
})

export default admin
