import { Hono } from 'hono'
import type { Env, Variables, DatabaseRow, PermissionRow } from '../types'
import { requireAuth } from '../middleware/auth'
import { now, audit, tables } from '../lib/db'
import { uuid } from '../lib/id'

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
    ).bind(userId).all<DatabaseRow>()
    rows = result.results
  }

  // Annotate with user's permission level
  const perms = await c.env.DB.prepare(
    `SELECT database_id, permission FROM ${T.user_database_permissions} WHERE user_id = ?1`
  ).bind(userId).all<{ database_id: string; permission: string }>()
  const permMap = new Map(perms.results.map((r) => [r.database_id, r.permission]))

  return c.json(rows.map((db) => ({
    id: db.id,
    name: db.name,
    description: db.description,
    binding_name: db.binding_name,
    permission: role === 'admin' ? 'write' : (permMap.get(db.id) ?? 'read'),
  })))
})

export default databases
