import { Hono } from 'hono'
import type { Env, Variables, DatabaseRow } from '../types'
import { requireAuth } from '../middleware/auth'
import { uuid } from '../lib/id'
import { now, tables } from '../lib/db'
import { classifySql, checkSqlAccess, isWriteClass, type Permission } from '../lib/sql-guard'

const MAX_RESULT_ROWS = 5000
const MAX_SQL_LENGTH = 100_000

const query = new Hono<{ Bindings: Env; Variables: Variables }>()
query.use('*', requireAuth)

// ── POST /api/query ────────────────────────────────────────────────────────────

query.post('/', async (c) => {
  const body = await c.req.json<{ databaseId?: string; sql?: string }>().catch(() => null)
  if (typeof body?.databaseId !== 'string' || typeof body.sql !== 'string' || !body.sql.trim()) {
    return c.json({ error: 'databaseId and sql are required' }, 400)
  }
  if (body.sql.length > MAX_SQL_LENGTH) return c.json({ error: 'SQL is too long' }, 413)

  const userId = c.get('userId')
  const role = c.get('userRole')
  const sql = body.sql.trim()

  const kind = classifySql(sql)
  if (kind === 'forbidden') return c.json({ error: 'This SQL statement is not allowed.' }, 403)

  // Resolve database + permission
  const T = tables(c.env)
  const db = await c.env.DB.prepare(`SELECT * FROM ${T.d1_databases} WHERE id = ?1 AND is_active = 1`)
    .bind(body.databaseId).first<DatabaseRow>()
  if (!db) return c.json({ error: 'Database not found' }, 404)

  let permission: Permission = 'read'
  if (role === 'admin') {
    permission = 'write_drop'
  } else {
    const perm = await c.env.DB.prepare(
      `SELECT permission FROM ${T.user_database_permissions} WHERE user_id = ?1 AND database_id = ?2`
    ).bind(userId, db.id).first<{ permission: string }>()
    if (!perm) return c.json({ error: 'Access denied' }, 403)
    permission = (perm.permission as Permission) ?? 'read'
  }

  const denied = checkSqlAccess(kind, permission)
  if (denied) return c.json({ error: denied }, kind === 'multiple' || kind === 'empty' ? 400 : 403)

  // Resolve the CF Worker binding
  const targetDb = c.env[db.binding_name]
  if (!targetDb || typeof (targetDb as Record<string, unknown>).prepare !== 'function') {
    return c.json({ error: `Binding "${db.binding_name}" not found. Contact the admin.` }, 500)
  }

  const d1 = targetDb as D1Database
  const start = Date.now()
  let result: unknown = null
  let errorMsg: string | null = null
  let rowCount = 0

  try {
    if (isWriteClass(kind)) {
      const res = await d1.prepare(sql).run()
      rowCount = res.meta.changes ?? 0
      result = { meta: res.meta, results: [] }
    } else {
      const res = await d1.prepare(sql).all()
      rowCount = res.results.length
      const truncated = rowCount > MAX_RESULT_ROWS
      result = { results: truncated ? res.results.slice(0, MAX_RESULT_ROWS) : res.results, meta: res.meta, truncated }
    }
  } catch (err) {
    errorMsg = err instanceof Error ? err.message : String(err)
  }

  const duration = Date.now() - start

  // Save history (non-blocking)
  c.executionCtx.waitUntil(
    c.env.DB.prepare(
      `INSERT INTO ${T.query_history} (id, user_id, database_id, sql, duration_ms, row_count, error, executed_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`
    ).bind(uuid(), userId, db.id, sql, duration, rowCount, errorMsg, now()).run()
  )

  if (errorMsg) return c.json({ error: errorMsg }, 400)
  return c.json({ ...(result as Record<string, unknown>), duration_ms: duration })
})

// ── POST /api/query/batch ─────────────────────────────────────────────────────

query.post('/batch', async (c) => {
  const body = await c.req.json<{ databaseId?: string; statements?: string[] }>().catch(() => null)
  if (
    typeof body?.databaseId !== 'string' ||
    !Array.isArray(body.statements) ||
    body.statements.length === 0 ||
    body.statements.some((x) => typeof x !== 'string')
  ) {
    return c.json({ error: 'databaseId and a non-empty statements array are required' }, 400)
  }
  if (body.statements.some((x) => x.length > MAX_SQL_LENGTH)) return c.json({ error: 'SQL is too long' }, 413)
  if (body.statements.length > 100) {
    return c.json({ error: 'Maximum 100 statements per batch' }, 400)
  }

  const userId = c.get('userId')
  const role = c.get('userRole')
  const T = tables(c.env)

  // Resolve database
  const db = await c.env.DB.prepare(`SELECT * FROM ${T.d1_databases} WHERE id = ?1 AND is_active = 1`)
    .bind(body.databaseId).first<DatabaseRow>()
  if (!db) return c.json({ error: 'Database not found' }, 404)

  // Check permission once
  let permission: Permission = 'read'
  if (role === 'admin') {
    permission = 'write_drop'
  } else {
    const perm = await c.env.DB.prepare(
      `SELECT permission FROM ${T.user_database_permissions} WHERE user_id = ?1 AND database_id = ?2`
    ).bind(userId, db.id).first<{ permission: string }>()
    if (!perm) return c.json({ error: 'Access denied' }, 403)
    permission = (perm.permission as Permission) ?? 'read'
  }

  // Resolve binding
  const targetDb = c.env[db.binding_name]
  if (!targetDb || typeof (targetDb as Record<string, unknown>).prepare !== 'function') {
    return c.json({ error: `Binding "${db.binding_name}" not found. Contact the admin.` }, 500)
  }
  const d1 = targetDb as D1Database

  // Run each statement sequentially, continue on error
  const results: Array<{
    sql: string
    results: Record<string, unknown>[]
    duration_ms: number
    changes?: number
    error?: string
    truncated?: boolean
  }> = []

  for (const rawSql of body.statements) {
    const sql = rawSql.trim()
    if (!sql) continue

    const kind = classifySql(sql)
    const denied = checkSqlAccess(kind, permission)
    if (denied) {
      results.push({ sql, results: [], duration_ms: 0, error: denied })
      continue
    }

    const start = Date.now()
    let stmtResult: Record<string, unknown>[] = []
    let changes: number | undefined
    let errorMsg: string | undefined
    let truncated = false

    try {
      if (isWriteClass(kind)) {
        const res = await d1.prepare(sql).run()
        changes = res.meta.changes ?? 0
      } else {
        const res = await d1.prepare(sql).all()
        stmtResult = res.results as Record<string, unknown>[]
        if (stmtResult.length > MAX_RESULT_ROWS) {
          stmtResult = stmtResult.slice(0, MAX_RESULT_ROWS)
          truncated = true
        }
      }
    } catch (err) {
      errorMsg = err instanceof Error ? err.message : String(err)
    }

    const duration = Date.now() - start
    const rowCount = errorMsg ? 0 : (changes !== undefined ? changes : stmtResult.length)

    // Save to history (non-blocking)
    c.executionCtx.waitUntil(
      c.env.DB.prepare(
        `INSERT INTO ${T.query_history} (id, user_id, database_id, sql, duration_ms, row_count, error, executed_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`
      ).bind(uuid(), userId, db.id, sql, duration, rowCount, errorMsg ?? null, now()).run()
    )

    const entry: typeof results[number] = { sql, results: stmtResult, duration_ms: duration }
    if (changes !== undefined) entry.changes = changes
    if (errorMsg) entry.error = errorMsg
    if (truncated) entry.truncated = true
    results.push(entry)
  }

  return c.json({ results })
})

// ── GET /api/query/history ────────────────────────────────────────────────────

query.get('/history', async (c) => {
  const userId = c.get('userId')
  const role = c.get('userRole')
  const limit = Math.min(Math.max(parseInt(c.req.query('limit') ?? '50', 10) || 50, 1), 200)
  const offset = Math.max(parseInt(c.req.query('offset') ?? '0', 10) || 0, 0)
  const dbId = c.req.query('databaseId')
  const T = tables(c.env)

  let rows
  if (dbId) {
    if (role === 'admin') {
      rows = await c.env.DB.prepare(
        `SELECT * FROM ${T.query_history} WHERE database_id = ?1 ORDER BY executed_at DESC LIMIT ?2 OFFSET ?3`
      ).bind(dbId, limit, offset).all()
    } else {
      rows = await c.env.DB.prepare(
        `SELECT * FROM ${T.query_history} WHERE user_id = ?1 AND database_id = ?2 ORDER BY executed_at DESC LIMIT ?3 OFFSET ?4`
      ).bind(userId, dbId, limit, offset).all()
    }
  } else {
    if (role === 'admin') {
      rows = await c.env.DB.prepare(
        `SELECT * FROM ${T.query_history} ORDER BY executed_at DESC LIMIT ?1 OFFSET ?2`
      ).bind(limit, offset).all()
    } else {
      rows = await c.env.DB.prepare(
        `SELECT * FROM ${T.query_history} WHERE user_id = ?1 ORDER BY executed_at DESC LIMIT ?2 OFFSET ?3`
      ).bind(userId, limit, offset).all()
    }
  }

  return c.json({ results: rows.results })
})

export default query
