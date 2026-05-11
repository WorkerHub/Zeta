import { Hono } from 'hono'
import type { Env, Variables, UserRow, DatabaseRow, PermissionRow } from '../types'
import { requireAdmin } from '../middleware/auth'
import { uuid } from '../lib/id'
import { now, getSetting, setSetting, getSettings, audit, tables } from '../lib/db'
import { hashPassword } from '../lib/auth'
import { KV } from '../lib/kv'
import { sendEmail } from '../lib/email'

const admin = new Hono<{ Bindings: Env; Variables: Variables }>()
admin.use('*', requireAdmin)

// ── Users ─────────────────────────────────────────────────────────────────────

admin.get('/users', async (c) => {
  const limit = Math.min(Math.max(parseInt(c.req.query('limit') ?? '50', 10) || 50, 1), 200)
  const offset = Math.max(parseInt(c.req.query('offset') ?? '0', 10) || 0, 0)
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
  ).bind(id, email, body.name.trim(), body.role ?? 'member', passwordHash, now()).run()

  c.executionCtx.waitUntil(audit(c.env, {
    userId: c.get('userId'), action: 'create_user', resource: id,
    ip: c.req.header('cf-connecting-ip')
  }))
  return c.json({ id }, 201)
})

admin.patch('/users/:id', async (c) => {
  const body = await c.req.json<{
    role?: string; two_factor_required?: boolean
    name?: string; email?: string; password?: string
  }>().catch(() => null)
  if (!body) return c.json({ error: 'Invalid body' }, 400)

  const updates: string[] = []
  const bindings: unknown[] = []
  let i = 1

  if (body.role !== undefined) {
    if (!['admin', 'member'].includes(body.role)) return c.json({ error: 'Invalid role' }, 400)
    if (body.role === 'member') {
      const T2 = tables(c.env)
      const adminCount = await c.env.DB.prepare(`SELECT COUNT(*) as n FROM ${T2.users} WHERE role = 'admin'`).first<{ n: number }>()
      const currentUser = await c.env.DB.prepare(`SELECT role FROM ${T2.users} WHERE id = ?1`).bind(c.req.param('id')).first<{ role: string }>()
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
    const conflict = await c.env.DB.prepare(
      `SELECT id FROM ${T2.users} WHERE email = ?1 AND id != ?2`
    ).bind(email, c.req.param('id')).first()
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
  await c.env.DB.prepare(
    `UPDATE ${T.users} SET ${updates.join(', ')} WHERE id = ?${i}`
  ).bind(...bindings).run()

  if ((body.password !== undefined && body.password !== '') || body.role !== undefined || body.email !== undefined) {
    await c.env.KV.put(KV.sessionInvalidatedAt(c.req.param('id')), String(now()), { expirationTtl: 7 * 24 * 3600 })
  }

  c.executionCtx.waitUntil(audit(c.env, {
    userId: c.get('userId'), action: 'update_user', resource: c.req.param('id'),
    ip: c.req.header('cf-connecting-ip')
  }))
  return c.json({ message: 'User updated' })
})

admin.delete('/users/:id', async (c) => {
  const id = c.req.param('id')
  if (id === c.get('userId')) return c.json({ error: 'Cannot delete yourself' }, 400)
  const T = tables(c.env)
  const target = await c.env.DB.prepare(`SELECT role FROM ${T.users} WHERE id = ?1`).bind(id).first<{ role: string }>()
  if (!target) return c.json({ error: 'User not found' }, 404)
  if (target.role === 'admin') {
    const adminCount = await c.env.DB.prepare(`SELECT COUNT(*) as n FROM ${T.users} WHERE role = 'admin'`).first<{ n: number }>()
    if ((adminCount?.n ?? 0) <= 1) return c.json({ error: 'Cannot delete the last admin' }, 400)
  }
  // D1 does not enforce FK CASCADE by default — delete/nullify all references manually
  await c.env.DB.batch([
    c.env.DB.prepare(`DELETE FROM ${T.totp_credentials} WHERE user_id = ?1`).bind(id),
    c.env.DB.prepare(`DELETE FROM ${T.passkey_credentials} WHERE user_id = ?1`).bind(id),
    c.env.DB.prepare(`DELETE FROM ${T.notebooks} WHERE user_id = ?1`).bind(id),
    c.env.DB.prepare(`DELETE FROM ${T.query_history} WHERE user_id = ?1`).bind(id),
    c.env.DB.prepare(`DELETE FROM ${T.user_database_permissions} WHERE user_id = ?1`).bind(id),
    c.env.DB.prepare(`UPDATE ${T.user_database_permissions} SET granted_by = NULL WHERE granted_by = ?1`).bind(id),
    c.env.DB.prepare(`UPDATE ${T.audit_logs} SET user_id = NULL WHERE user_id = ?1`).bind(id),
    c.env.DB.prepare(`UPDATE ${T.d1_databases} SET created_by = NULL WHERE created_by = ?1`).bind(id),
    c.env.DB.prepare(`DELETE FROM ${T.users} WHERE id = ?1`).bind(id),
  ])
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

  c.executionCtx.waitUntil(audit(c.env, {
    userId: c.get('userId'), action: 'create_database', resource: id,
    ip: c.req.header('cf-connecting-ip')
  }))
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

  c.executionCtx.waitUntil(audit(c.env, {
    userId: c.get('userId'), action: 'update_database', resource: c.req.param('id'),
    ip: c.req.header('cf-connecting-ip')
  }))
  return c.json({ message: 'Updated' })
})

admin.delete('/databases/:id', async (c) => {
  const T = tables(c.env)
  const dbId = c.req.param('id')
  await c.env.DB.batch([
    c.env.DB.prepare(`DELETE FROM ${T.user_database_permissions} WHERE database_id = ?1`).bind(dbId),
    c.env.DB.prepare(`DELETE FROM ${T.query_history} WHERE database_id = ?1`).bind(dbId),
    c.env.DB.prepare(`DELETE FROM ${T.d1_databases} WHERE id = ?1`).bind(dbId),
  ])
  c.executionCtx.waitUntil(audit(c.env, {
    userId: c.get('userId'), action: 'delete_database', resource: dbId,
    ip: c.req.header('cf-connecting-ip')
  }))
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
  if (!body?.permission || !['read', 'write', 'write_drop'].includes(body.permission)) {
    return c.json({ error: 'permission must be "read", "write", or "write_drop"' }, 400)
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
  'email_provider', 'smtp_config', 'resend_config', 'app_name',
]

admin.get('/settings', async (c) => {
  const cfg = await getSettings(c.env, EXPOSED_SETTINGS)
  // Mask secrets in JSON blobs
  if (cfg['smtp_config']) {
    try {
      const smtp = JSON.parse(cfg['smtp_config'])
      if (smtp.password) smtp.password = '••••••'
      cfg['smtp_config'] = JSON.stringify(smtp)
    } catch { /* ignore malformed */ }
  }
  if (cfg['resend_config']) {
    try {
      const resend = JSON.parse(cfg['resend_config'])
      if (resend.api_key) resend.api_key = '••••••'
      cfg['resend_config'] = JSON.stringify(resend)
    } catch { /* ignore malformed */ }
  }
  return c.json(cfg)
})

const BOOLEAN_SETTINGS = new Set(['registration_enabled', 'require_email_verification', 'enforce_2fa'])
const VALID_EMAIL_PROVIDERS = ['none', 'resend', 'smtp']

admin.patch('/settings', async (c) => {
  const body = await c.req.json<Record<string, string>>().catch(() => null)
  if (!body) return c.json({ error: 'Invalid body' }, 400)

  const allowed = new Set(EXPOSED_SETTINGS)
  const existingSettings = await getSettings(c.env, EXPOSED_SETTINGS)

  for (const [key, value] of Object.entries(body)) {
    if (!allowed.has(key)) continue

    const v = String(value)
    if (BOOLEAN_SETTINGS.has(key) && v !== 'true' && v !== 'false') continue
    if (key === 'email_provider' && !VALID_EMAIL_PROVIDERS.includes(v)) continue

    if (key === 'smtp_config') {
      let newConfig: Record<string, unknown>
      try { newConfig = JSON.parse(v) } catch { continue }
      // Don't overwrite password with redacted placeholder
      if (!newConfig.password) {
        let existing: Record<string, unknown> = {}
        try { existing = existingSettings['smtp_config'] ? JSON.parse(existingSettings['smtp_config']) : {} } catch { /* */ }
        newConfig.password = (existing as Record<string, string>).password || ''
      }
      await setSetting(c.env, key, JSON.stringify(newConfig))
    } else if (key === 'resend_config') {
      let newConfig: Record<string, unknown>
      try { newConfig = JSON.parse(v) } catch { continue }
      // Don't overwrite api_key with redacted placeholder
      if (!newConfig.api_key) {
        let existing: Record<string, unknown> = {}
        try { existing = existingSettings['resend_config'] ? JSON.parse(existingSettings['resend_config']) : {} } catch { /* */ }
        newConfig.api_key = (existing as Record<string, string>).api_key || ''
      }
      await setSetting(c.env, key, JSON.stringify(newConfig))
    } else {
      await setSetting(c.env, key, v)
    }
  }

  c.executionCtx.waitUntil(audit(c.env, {
    userId: c.get('userId'), action: 'update_settings',
    ip: c.req.header('cf-connecting-ip')
  }))
  return c.json({ message: 'Settings saved' })
})

// ── Test email ─────────────────────────────────────────────────────────────────

const EMAIL_RE = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/

admin.post('/settings/test-email', async (c) => {
  const { to } = await c.req.json<{ to: string }>()
  if (!to || !EMAIL_RE.test(to)) return c.json({ error: 'Invalid email address' }, 400)

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

// ── Setup (first-run) ─────────────────────────────────────────────────────────

admin.post('/setup/complete', async (c) => {
  await setSetting(c.env, 'setup_completed', 'true')
  return c.json({ message: 'Setup completed' })
})

export default admin
