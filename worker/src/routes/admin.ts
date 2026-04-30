import { Hono } from 'hono'
import type { Env, Variables, UserRow, DatabaseRow, PermissionRow } from '../types'
import { requireAdmin } from '../middleware/auth'
import { nanoid, uuid } from '../lib/id'
import { now, getSetting, setSetting, getSettings, audit, tables } from '../lib/db'
import { hashPassword } from '../lib/auth'

const admin = new Hono<{ Bindings: Env; Variables: Variables }>()
admin.use('*', requireAdmin)

// ── Users ─────────────────────────────────────────────────────────────────────

admin.get('/users', async (c) => {
  const limit = Math.min(parseInt(c.req.query('limit') ?? '50', 10), 200)
  const offset = parseInt(c.req.query('offset') ?? '0', 10)
  const search = c.req.query('search')?.trim()
  const T = tables(c.env)

  let rows, total
  if (search) {
    const like = `%${search.replace(/[%_\\]/g, '\\$&')}%`
    rows = await c.env.DB.prepare(
      `SELECT id, email, name, role, email_verified, two_factor_required, created_at
       FROM ${T.users} WHERE email LIKE ?1 ESCAPE '\\' OR name LIKE ?1 ESCAPE '\\'
       ORDER BY created_at DESC LIMIT ?2 OFFSET ?3`
    ).bind(like, limit, offset).all<Omit<UserRow, 'password_hash' | 'updated_at'>>()
    total = await c.env.DB.prepare(
      `SELECT COUNT(*) as n FROM ${T.users} WHERE email LIKE ?1 ESCAPE '\\' OR name LIKE ?1 ESCAPE '\\'`
    ).bind(like).first<{ n: number }>()
  } else {
    rows = await c.env.DB.prepare(
      `SELECT id, email, name, role, email_verified, two_factor_required, created_at
       FROM ${T.users} ORDER BY created_at DESC LIMIT ?1 OFFSET ?2`
    ).bind(limit, offset).all<Omit<UserRow, 'password_hash' | 'updated_at'>>()
    total = await c.env.DB.prepare(`SELECT COUNT(*) as n FROM ${T.users}`).first<{ n: number }>()
  }

  return c.json({ results: rows.results, total: total?.n ?? 0 })
})

admin.get('/users/:id', async (c) => {
  const T = tables(c.env)
  const user = await c.env.DB.prepare(
    `SELECT id, email, name, role, email_verified, two_factor_required, created_at FROM ${T.users} WHERE id = ?1`
  ).bind(c.req.param('id')).first<Omit<UserRow, 'password_hash' | 'updated_at'>>()
  if (!user) return c.json({ error: 'User not found' }, 404)

  const perms = await c.env.DB.prepare(
    `SELECT p.*, d.name as database_name FROM ${T.user_database_permissions} p
     JOIN ${T.d1_databases} d ON d.id = p.database_id WHERE p.user_id = ?1`
  ).bind(user.id).all()

  return c.json({ ...user, permissions: perms.results })
})

admin.patch('/users/:id', async (c) => {
  const body = await c.req.json<{ role?: string; two_factor_required?: boolean }>().catch(() => null)
  if (!body) return c.json({ error: 'Invalid body' }, 400)

  const updates: string[] = []
  const bindings: unknown[] = []
  let i = 1

  if (body.role !== undefined) {
    if (!['admin', 'member'].includes(body.role)) return c.json({ error: 'Invalid role' }, 400)
    updates.push(`role = ?${i++}`)
    bindings.push(body.role)
  }
  if (body.two_factor_required !== undefined) {
    updates.push(`two_factor_required = ?${i++}`)
    bindings.push(body.two_factor_required ? 1 : 0)
  }

  if (updates.length === 0) return c.json({ error: 'Nothing to update' }, 400)

  updates.push(`updated_at = ?${i++}`)
  bindings.push(now())
  bindings.push(c.req.param('id'))

  const T = tables(c.env)
  await c.env.DB.prepare(
    `UPDATE ${T.users} SET ${updates.join(', ')} WHERE id = ?${i}`
  ).bind(...bindings).run()

  return c.json({ message: 'User updated' })
})

admin.delete('/users/:id', async (c) => {
  const id = c.req.param('id')
  if (id === c.get('userId')) return c.json({ error: 'Cannot delete yourself' }, 400)
  const T = tables(c.env)
  await c.env.DB.prepare(`DELETE FROM ${T.users} WHERE id = ?1`).bind(id).run()
  c.executionCtx.waitUntil(audit(c.env, {
    userId: c.get('userId'), action: 'delete_user', resource: id,
    ip: c.req.header('cf-connecting-ip')
  }))
  return c.json({ message: 'User deleted' })
})

// ── Database registry ─────────────────────────────────────────────────────────

admin.get('/databases', async (c) => {
  const T = tables(c.env)
  const rows = await c.env.DB.prepare(`SELECT * FROM ${T.d1_databases} ORDER BY name`).all<DatabaseRow>()
  return c.json({ results: rows.results })
})

admin.post('/databases', async (c) => {
  const body = await c.req.json<{
    name?: string; description?: string; binding_name?: string
  }>().catch(() => null)
  if (!body?.name || !body.binding_name) {
    return c.json({ error: 'name and binding_name are required' }, 400)
  }

  // Validate the binding actually exists on this Worker
  const binding = c.env[body.binding_name]
  if (!binding || typeof (binding as Record<string, unknown>).prepare !== 'function') {
    return c.json({ error: `Binding "${body.binding_name}" not found on this Worker. Add it to wrangler.toml first.` }, 400)
  }

  const T = tables(c.env)
  const id = uuid()
  await c.env.DB.prepare(
    `INSERT INTO ${T.d1_databases} (id, name, description, binding_name, is_active, created_at, created_by)
     VALUES (?1, ?2, ?3, ?4, 1, ?5, ?6)`
  ).bind(id, body.name, body.description ?? null, body.binding_name, now(), c.get('userId')).run()

  return c.json({ id }, 201)
})

admin.patch('/databases/:id', async (c) => {
  const body = await c.req.json<{ name?: string; description?: string; is_active?: boolean }>().catch(() => null)
  if (!body) return c.json({ error: 'Invalid body' }, 400)

  const updates: string[] = []
  const bindings: unknown[] = []
  let i = 1

  if (body.name) { updates.push(`name = ?${i++}`); bindings.push(body.name) }
  if (body.description !== undefined) { updates.push(`description = ?${i++}`); bindings.push(body.description) }
  if (body.is_active !== undefined) { updates.push(`is_active = ?${i++}`); bindings.push(body.is_active ? 1 : 0) }

  if (updates.length === 0) return c.json({ error: 'Nothing to update' }, 400)
  bindings.push(c.req.param('id'))

  const T = tables(c.env)
  await c.env.DB.prepare(`UPDATE ${T.d1_databases} SET ${updates.join(', ')} WHERE id = ?${i}`)
    .bind(...bindings).run()

  return c.json({ message: 'Updated' })
})

admin.delete('/databases/:id', async (c) => {
  const T = tables(c.env)
  await c.env.DB.prepare(`DELETE FROM ${T.d1_databases} WHERE id = ?1`).bind(c.req.param('id')).run()
  return c.json({ message: 'Deleted' })
})

// ── Permissions ───────────────────────────────────────────────────────────────

admin.get('/databases/:id/permissions', async (c) => {
  const T = tables(c.env)
  const rows = await c.env.DB.prepare(
    `SELECT p.*, u.email, u.name as user_name
     FROM ${T.user_database_permissions} p JOIN ${T.users} u ON u.id = p.user_id
     WHERE p.database_id = ?1`
  ).bind(c.req.param('id')).all()
  return c.json({ results: rows.results })
})

admin.put('/databases/:id/permissions/:userId', async (c) => {
  const body = await c.req.json<{ permission?: string }>().catch(() => null)
  if (!body?.permission || !['read', 'write'].includes(body.permission)) {
    return c.json({ error: 'permission must be "read" or "write"' }, 400)
  }

  const T = tables(c.env)
  await c.env.DB.prepare(
    `INSERT INTO ${T.user_database_permissions} (id, user_id, database_id, permission, granted_by, granted_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6)
     ON CONFLICT(user_id, database_id) DO UPDATE SET permission = ?4, granted_by = ?5, granted_at = ?6`
  ).bind(uuid(), c.req.param('userId'), c.req.param('id'), body.permission, c.get('userId'), now()).run()

  return c.json({ message: 'Permission set' })
})

admin.delete('/databases/:id/permissions/:userId', async (c) => {
  const T = tables(c.env)
  await c.env.DB.prepare(
    `DELETE FROM ${T.user_database_permissions} WHERE user_id = ?1 AND database_id = ?2`
  ).bind(c.req.param('userId'), c.req.param('id')).run()
  return c.json({ message: 'Permission revoked' })
})

// ── Settings ──────────────────────────────────────────────────────────────────

const EXPOSED_SETTINGS = [
  'registration_enabled', 'require_email_verification', 'enforce_2fa',
  'email_provider', 'resend_api_key', 'smtp_host', 'smtp_port',
  'smtp_user', 'smtp_pass', 'smtp_from', 'app_name',
]

admin.get('/settings', async (c) => {
  const cfg = await getSettings(c.env, EXPOSED_SETTINGS)
  // Mask secrets
  if (cfg['resend_api_key']) cfg['resend_api_key'] = '••••••••'
  if (cfg['smtp_pass']) cfg['smtp_pass'] = '••••••••'
  return c.json(cfg)
})

admin.patch('/settings', async (c) => {
  const body = await c.req.json<Record<string, string>>().catch(() => null)
  if (!body) return c.json({ error: 'Invalid body' }, 400)

  const allowed = new Set(EXPOSED_SETTINGS)
  const updates: Array<[string, string]> = []

  for (const [key, value] of Object.entries(body)) {
    if (!allowed.has(key)) continue
    // Don't overwrite masked values with placeholder
    if (value === '••••••••') continue
    updates.push([key, String(value)])
  }

  await Promise.all(updates.map(([k, v]) => setSetting(c.env, k, v)))

  c.executionCtx.waitUntil(audit(c.env, {
    userId: c.get('userId'), action: 'update_settings',
    ip: c.req.header('cf-connecting-ip')
  }))
  return c.json({ message: 'Settings saved' })
})

// ── Setup (first-run) ─────────────────────────────────────────────────────────

admin.post('/setup/complete', async (c) => {
  await setSetting(c.env, 'setup_completed', 'true')
  return c.json({ message: 'Setup completed' })
})

export default admin
