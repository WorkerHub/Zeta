import { Hono } from 'hono'
import { capAppDbPermission } from '../lib/app-db-guard'
import { isAppDb } from '../lib/d1-http'
import { tables } from '../lib/db'
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
    rows.map((db) => {
      const appDb = isAppDb(c.env, db.cf_database_id)
      // The application database's permission is capped at write: the admin's implicit write_drop
      // and any stored write_drop are reported at their effective level, never as write_drop.
      const base: Permission = role === 'admin' ? 'write_drop' : ((permMap.get(db.id) ?? 'read') as Permission)
      return {
        id: db.id,
        name: db.name,
        description: db.description,
        ...(role === 'admin' ? { binding_name: db.binding_name, cf_database_id: db.cf_database_id } : {}),
        is_app_db: appDb,
        permission: appDb ? capAppDbPermission(base) : base,
      }
    })
  )
})

export default databases
