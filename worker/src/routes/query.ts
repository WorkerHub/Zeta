import { Hono } from 'hono'
import type { Env, Variables, DatabaseRow } from '../types'
import { requireAuth } from '../middleware/auth'
import { nanoid, uuid } from '../lib/id'
import { now, audit, tables } from '../lib/db'

const query = new Hono<{ Bindings: Env; Variables: Variables }>()
query.use('*', requireAuth)

// SQL statements that are never allowed regardless of permission level
const FORBIDDEN_PATTERNS = [
  /pragma\s+\w+\s*=/i,       // PRAGMA writes
  /attach\s+database/i,
  /detach\s+database/i,
]

function isForbiddenSql(sql: string): boolean {
  return FORBIDDEN_PATTERNS.some((re) => re.test(sql))
}

function isWriteSql(sql: string): boolean {
  return /^\s*(insert|update|delete|create|alter|drop|truncate|replace)\s+/i.test(sql)
}

// ── POST /api/query ────────────────────────────────────────────────────────────

query.post('/', async (c) => {
  const body = await c.req.json<{ databaseId?: string; sql?: string }>().catch(() => null)
  if (!body?.databaseId || !body.sql?.trim()) {
    return c.json({ error: 'databaseId and sql are required' }, 400)
  }

  const userId = c.get('userId')
  const role = c.get('userRole')
  const sql = body.sql.trim()

  if (isForbiddenSql(sql)) {
    return c.json({ error: 'This SQL statement is not allowed.' }, 403)
  }

  // Resolve database + permission
  const T = tables(c.env)
  const db = await c.env.DB.prepare(`SELECT * FROM ${T.d1_databases} WHERE id = ?1 AND is_active = 1`)
    .bind(body.databaseId).first<DatabaseRow>()
  if (!db) return c.json({ error: 'Database not found' }, 404)

  let permission: 'read' | 'write' = 'read'
  if (role === 'admin') {
    permission = 'write'
  } else {
    const perm = await c.env.DB.prepare(
      `SELECT permission FROM ${T.user_database_permissions} WHERE user_id = ?1 AND database_id = ?2`
    ).bind(userId, db.id).first<{ permission: string }>()
    if (!perm) return c.json({ error: 'Access denied' }, 403)
    permission = (perm.permission as 'read' | 'write') ?? 'read'
  }

  if (isWriteSql(sql) && permission !== 'write') {
    return c.json({ error: 'You only have read access to this database.' }, 403)
  }

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
    if (isWriteSql(sql)) {
      const res = await d1.prepare(sql).run()
      rowCount = res.meta.changes ?? 0
      result = { meta: res.meta, results: [] }
    } else {
      const res = await d1.prepare(sql).all()
      rowCount = res.results.length
      result = { results: res.results, meta: res.meta }
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
  if (!body?.databaseId || !Array.isArray(body.statements) || body.statements.length === 0) {
    return c.json({ error: 'databaseId and a non-empty statements array are required' }, 400)
  }

  const userId = c.get('userId')
  const role = c.get('userRole')
  const T = tables(c.env)

  // Resolve database
  const db = await c.env.DB.prepare(`SELECT * FROM ${T.d1_databases} WHERE id = ?1 AND is_active = 1`)
    .bind(body.databaseId).first<DatabaseRow>()
  if (!db) return c.json({ error: 'Database not found' }, 404)

  // Check permission once
  let permission: 'read' | 'write' = 'read'
  if (role === 'admin') {
    permission = 'write'
  } else {
    const perm = await c.env.DB.prepare(
      `SELECT permission FROM ${T.user_database_permissions} WHERE user_id = ?1 AND database_id = ?2`
    ).bind(userId, db.id).first<{ permission: string }>()
    if (!perm) return c.json({ error: 'Access denied' }, 403)
    permission = (perm.permission as 'read' | 'write') ?? 'read'
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
  }> = []

  for (const rawSql of body.statements) {
    const sql = rawSql.trim()
    if (!sql) continue

    // Forbidden check — record error, continue
    if (isForbiddenSql(sql)) {
      results.push({ sql, results: [], duration_ms: 0, error: 'This SQL statement is not allowed.' })
      continue
    }

    // Write permission check
    if (isWriteSql(sql) && permission !== 'write') {
      results.push({ sql, results: [], duration_ms: 0, error: 'You only have read access to this database.' })
      continue
    }

    const start = Date.now()
    let stmtResult: Record<string, unknown>[] = []
    let changes: number | undefined
    let errorMsg: string | undefined

    try {
      if (isWriteSql(sql)) {
        const res = await d1.prepare(sql).run()
        changes = res.meta.changes ?? 0
      } else {
        const res = await d1.prepare(sql).all()
        stmtResult = res.results as Record<string, unknown>[]
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
    results.push(entry)
  }

  return c.json({ results })
})

// ── GET /api/query/history ────────────────────────────────────────────────────

query.get('/history', async (c) => {
  const userId = c.get('userId')
  const role = c.get('userRole')
  const limit = Math.min(parseInt(c.req.query('limit') ?? '50', 10), 200)
  const offset = parseInt(c.req.query('offset') ?? '0', 10)
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
