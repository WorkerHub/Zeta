import { Hono } from 'hono'
import type { Env, Variables, DatabaseRow } from '../types'
import { requireAuth } from '../middleware/auth'
import { uuid } from '../lib/id'
import { now, audit, tables } from '../lib/db'

const query = new Hono<{ Bindings: Env; Variables: Variables }>()
query.use('*', requireAuth)

// SQL statements that are never allowed regardless of permission level.
// Anchored to ^ so they only match as the SQL command, not inside string literals.
const FORBIDDEN_PATTERNS = [
  /^\s*pragma\s+\w+\s*=/i,
  /^\s*attach\s+database/i,
  /^\s*detach\s+database/i,
]

function stripAllComments(sql: string): string {
  let result = ''
  let i = 0
  while (i < sql.length) {
    if (sql[i] === '-' && sql[i + 1] === '-') {
      while (i < sql.length && sql[i] !== '\n') i++
      result += ' '
    } else if (sql[i] === '/' && sql[i + 1] === '*') {
      i += 2
      while (i < sql.length) {
        if (i + 1 < sql.length && sql[i] === '*' && sql[i + 1] === '/') {
          i += 2
          break
        }
        i++
      }
      result += ' '
    } else if (sql[i] === "'" || sql[i] === '"') {
      const quote = sql[i]!
      result += sql[i++]
      while (i < sql.length) {
        result += sql[i]
        if (sql[i] === quote) {
          i++
          if (i >= sql.length || sql[i] !== quote) break
          result += sql[i++]
        } else {
          i++
        }
      }
    } else {
      result += sql[i++]
    }
  }
  return result
}

function skipBalancedParens(s: string, start: number): number {
  let depth = 0
  for (let i = start; i < s.length; i++) {
    if (s[i] === "'" || s[i] === '"') {
      const quote = s[i]!
      i++
      while (i < s.length) {
        if (s[i] === quote) {
          if (i + 1 < s.length && s[i + 1] === quote) { i += 2; continue }
          break
        }
        i++
      }
      continue
    }
    if (s[i] === '(') depth++
    else if (s[i] === ')') { depth--; if (depth === 0) return i }
  }
  return -1
}

function stripOneCte(s: string): { rest: string; hasMore: boolean } | null {
  const parenStart = s.indexOf('(')
  if (parenStart === -1) return null

  const parenEnd = skipBalancedParens(s, parenStart)
  if (parenEnd === -1) return null

  let rest = s.slice(parenEnd + 1).trim()

  // If rest starts with AS, the paren was a column list — find the actual CTE body
  if (/^as\s/i.test(rest)) {
    rest = rest.slice(2).trim()
    const bodyStart = rest.indexOf('(')
    if (bodyStart === -1) return null
    const bodyEnd = skipBalancedParens(rest, bodyStart)
    if (bodyEnd === -1) return null
    rest = rest.slice(bodyEnd + 1).trim()
  }

  if (rest.startsWith(',')) {
    return { rest: rest.slice(1).trim(), hasMore: true }
  }
  return { rest, hasMore: false }
}

function normalizeForClassification(sql: string): string {
  const noComments = stripAllComments(sql)
  let s = noComments.trim()

  if (!/^with\s+/i.test(s)) return s

  const MAX_CTES = 20
  for (let n = 0; n < MAX_CTES; n++) {
    const result = stripOneCte(s)
    if (!result) break
    if (!result.hasMore) return result.rest
    s = result.rest
  }

  return s
}

function isForbiddenSql(sql: string): boolean {
  const noComments = stripAllComments(sql)
  return FORBIDDEN_PATTERNS.some((re) => re.test(noComments))
}

function isWriteSql(sql: string): boolean {
  const normalized = normalizeForClassification(sql)
  return /^\s*(insert|update|delete|create|alter|drop|truncate|replace)\s+/i.test(normalized)
}

function isDestructiveSql(sql: string): boolean {
  const normalized = normalizeForClassification(sql)
  return /^\s*(drop|truncate)\s+/i.test(normalized)
}

type Permission = 'read' | 'write' | 'write_drop'

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

  if (isDestructiveSql(sql) && permission !== 'write_drop') {
    return c.json({ error: 'This statement requires elevated permissions (level 3: write & drop).' }, 403)
  }
  if (isWriteSql(sql) && permission === 'read') {
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
  }> = []

  for (const rawSql of body.statements) {
    const sql = rawSql.trim()
    if (!sql) continue

    // Forbidden check — record error, continue
    if (isForbiddenSql(sql)) {
      results.push({ sql, results: [], duration_ms: 0, error: 'This SQL statement is not allowed.' })
      continue
    }

    // Permission checks
    if (isDestructiveSql(sql) && permission !== 'write_drop') {
      results.push({ sql, results: [], duration_ms: 0, error: 'This statement requires elevated permissions (level 3: write & drop).' })
      continue
    }
    if (isWriteSql(sql) && permission === 'read') {
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
