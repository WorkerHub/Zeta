import { Hono, type Context } from 'hono'
import type { D1Database } from '@cloudflare/workers-types'
import type { Env, Variables, DatabaseRow } from '../types'
import { requireAuth } from '../middleware/auth'
import { uuid } from '../lib/id'
import { now, tables } from '../lib/db'
import { resolveQueryBinding } from '../lib/bindings'
import {
  classifySql,
  checkSqlAccess,
  isWriteClass,
  limitReadSql,
  type Permission,
  type SqlClass,
} from '../lib/sql-guard'
import { translateMySql } from '../lib/mysql-compat'
import { reserveRunSeq, saveRun, type RunStatement } from '../lib/runs'

const MAX_RESULT_ROWS = 5000
const MAX_SQL_LENGTH = 100_000

const query = new Hono<{ Bindings: Env; Variables: Variables }>()
query.use('*', requireAuth)

// A registered database whose binding is missing or unusable. The detail names the binding, an
// internal deployment detail, so only admins (who manage bindings anyway) get to see it.
function bindingError(c: Context<{ Bindings: Env; Variables: Variables }>, detail: string) {
  if (c.get('userRole') === 'admin') return c.json({ error: `${detail} Contact the admin.` }, 500)
  console.error(`Query binding error: ${detail}`)
  return c.json({ error: 'Database configuration error. Contact the admin.' }, 500)
}

type Ctx = Context<{ Bindings: Env; Variables: Variables }>

// The optional notebookId a run is saved under: undefined/null = not saved, otherwise it must be
// one of the caller's notebooks. Returns an error response, null when absent, or the notebook with
// the number its run gets (see reserveRunSeq). Pass save = false when nothing will run, so no
// number is used up; `seq` is then null and nothing is saved.
async function resolveNotebook(
  c: Ctx,
  notebookId: unknown,
  save = true
): Promise<Response | { id: string; seq: number | null } | null> {
  if (notebookId === undefined || notebookId === null) return null
  if (typeof notebookId !== 'string' || !notebookId) return c.json({ error: 'Invalid notebookId' }, 400)
  const notFound = () => c.json({ error: 'Notebook not found' }, 404)
  if (save) {
    const reserved = await reserveRunSeq(c.env, notebookId, c.get('userId'))
    return reserved ? { id: notebookId, seq: reserved.seq } : notFound()
  }
  const T = tables(c.env)
  const row = await c.env.DB.prepare(`SELECT 1 FROM ${T.notebooks} WHERE id = ?1 AND user_id = ?2`)
    .bind(notebookId, c.get('userId'))
    .first()
  return row ? { id: notebookId, seq: null } : notFound()
}

interface Executed {
  results: Record<string, unknown>[]
  meta: Record<string, unknown>
  changes?: number
  truncated: boolean
}

// Runs one statement that already passed classification and the permission check. Reads are
// capped by the database itself: wrapped in `LIMIT MAX_RESULT_ROWS + 1` (see limitReadSql), the
// extra row only telling that the result was cut off. EXPLAIN and PRAGMA cannot be wrapped and are
// cut off here instead.
async function executeStatement(d1: D1Database, sql: string, kind: SqlClass): Promise<Executed> {
  if (isWriteClass(kind)) {
    const res = await d1.prepare(sql).run()
    return { results: [], meta: res.meta as Record<string, unknown>, changes: res.meta.changes ?? 0, truncated: false }
  }
  const limited = limitReadSql(sql, MAX_RESULT_ROWS)
  const res = await d1.prepare(limited ?? sql).all()
  const rows = res.results as Record<string, unknown>[]
  const truncated = rows.length > MAX_RESULT_ROWS
  return {
    results: truncated ? rows.slice(0, MAX_RESULT_ROWS) : rows,
    meta: res.meta as Record<string, unknown>,
    truncated,
  }
}

// Rewrites a MySQL introspection statement (SHOW TABLES, DESCRIBE, …) into its read-only
// SQLite equivalent. `error` is set for statements that are recognised but unsupported
// (SHOW DATABASES); `sql` is the statement to classify and run — the rewrite, or the
// caller's input unchanged.
function translate(sql: string): { sql: string; error?: string } {
  const result = translateMySql(sql)
  if (result?.type === 'error') return { sql, error: result.message }
  if (result?.type === 'sql') return { sql: result.sql }
  return { sql }
}

// ── POST /api/query ────────────────────────────────────────────────────────────

query.post('/', async (c) => {
  const body = await c.req.json<{ databaseId?: string; sql?: string; notebookId?: unknown }>().catch(() => null)
  if (typeof body?.databaseId !== 'string' || typeof body.sql !== 'string' || !body.sql.trim()) {
    return c.json({ error: 'databaseId and sql are required' }, 400)
  }
  if (body.sql.length > MAX_SQL_LENGTH) return c.json({ error: 'SQL is too long' }, 413)

  const userId = c.get('userId')
  const role = c.get('userRole')
  const sql = body.sql.trim()
  const { sql: runSql, error: translateError } = translate(sql)
  if (translateError) return c.json({ error: translateError }, 400)

  const kind = classifySql(runSql)
  if (kind === 'forbidden') return c.json({ error: 'This SQL statement is not allowed.' }, 403)

  // Resolve database + permission
  const T = tables(c.env)
  const db = await c.env.DB.prepare(`SELECT * FROM ${T.d1_databases} WHERE id = ?1 AND is_active = 1`)
    .bind(body.databaseId)
    .first<DatabaseRow>()
  if (!db) return c.json({ error: 'Database not found' }, 404)

  let permission: Permission = 'read'
  if (role === 'admin') {
    permission = 'write_drop'
  } else {
    const perm = await c.env.DB.prepare(
      `SELECT permission FROM ${T.user_database_permissions} WHERE user_id = ?1 AND database_id = ?2`
    )
      .bind(userId, db.id)
      .first<{ permission: string }>()
    if (!perm) return c.json({ error: 'Access denied' }, 403)
    permission = (perm.permission as Permission) ?? 'read'
  }

  const denied = checkSqlAccess(kind, permission)
  if (denied) return c.json({ error: denied }, kind === 'multiple' || kind === 'empty' ? 400 : 403)

  // Resolve the CF Worker binding
  const binding = resolveQueryBinding(c.env, db.binding_name)
  if (!binding.ok) return bindingError(c, binding.error)

  const notebook = await resolveNotebook(c, body.notebookId)
  if (notebook instanceof Response) return notebook

  const d1 = binding.db
  const executedAt = Date.now()
  let result: Executed | null = null
  let errorMsg: string | null = null

  try {
    result = await executeStatement(d1, runSql, kind)
  } catch (err) {
    errorMsg = err instanceof Error ? err.message : String(err)
  }

  const duration = Date.now() - executedAt
  const rowCount = result ? (result.changes ?? result.results.length) : 0

  // Save history (non-blocking)
  c.executionCtx.waitUntil(
    c.env.DB.prepare(
      `INSERT INTO ${T.query_history} (id, user_id, database_id, sql, duration_ms, row_count, error, executed_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`
    )
      .bind(uuid(), userId, db.id, sql, duration, rowCount, errorMsg, now())
      .run()
  )

  // Save the run under its notebook (non-blocking)
  let run: { run_id: string; executed_at: number; seq: number } | null = null
  if (notebook?.seq != null) {
    const statement: RunStatement = { sql, results: result?.results ?? [], duration_ms: duration }
    if (result?.changes !== undefined) statement.changes = result.changes
    if (result?.truncated) statement.truncated = true
    if (errorMsg) statement.error = errorMsg
    run = { run_id: uuid(), executed_at: executedAt, seq: notebook.seq }
    c.executionCtx.waitUntil(
      saveRun(c.env, {
        id: run.run_id,
        seq: notebook.seq,
        notebookId: notebook.id,
        userId,
        databaseId: db.id,
        sql,
        statements: [statement],
        durationMs: duration,
        executedAt,
      })
    )
  }

  if (errorMsg || !result) return c.json({ error: errorMsg, ...run }, 400)
  const payload = isWriteClass(kind)
    ? { meta: result.meta, results: [] }
    : { results: result.results, meta: result.meta, truncated: result.truncated }
  return c.json({ ...payload, duration_ms: duration, ...run })
})

// ── POST /api/query/batch ─────────────────────────────────────────────────────

query.post('/batch', async (c) => {
  const body = await c.req
    .json<{ databaseId?: string; statements?: string[]; notebookId?: unknown }>()
    .catch(() => null)
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
    .bind(body.databaseId)
    .first<DatabaseRow>()
  if (!db) return c.json({ error: 'Database not found' }, 404)

  // Check permission once
  let permission: Permission = 'read'
  if (role === 'admin') {
    permission = 'write_drop'
  } else {
    const perm = await c.env.DB.prepare(
      `SELECT permission FROM ${T.user_database_permissions} WHERE user_id = ?1 AND database_id = ?2`
    )
      .bind(userId, db.id)
      .first<{ permission: string }>()
    if (!perm) return c.json({ error: 'Access denied' }, 403)
    permission = (perm.permission as Permission) ?? 'read'
  }

  // Resolve binding
  const binding = resolveQueryBinding(c.env, db.binding_name)
  if (!binding.ok) return bindingError(c, binding.error)
  const d1 = binding.db

  // A batch whose statements are all rejected before running is not saved, like a rejected single
  // one, and uses up no run number
  const runsAny = body.statements.some((x) => {
    const sql = x.trim()
    if (!sql) return false
    const translated = translate(sql)
    if (translated.error) return false
    return !checkSqlAccess(classifySql(translated.sql), permission)
  })
  const notebook = await resolveNotebook(c, body.notebookId, runsAny)
  if (notebook instanceof Response) return notebook
  const executedAt = Date.now()

  // Run each statement sequentially, continue on error
  const results: RunStatement[] = []

  for (const rawSql of body.statements) {
    const sql = rawSql.trim()
    if (!sql) continue

    const { sql: runSql, error: translateError } = translate(sql)
    if (translateError) {
      results.push({ sql, results: [], duration_ms: 0, error: translateError })
      continue
    }

    const kind = classifySql(runSql)
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
      const executed = await executeStatement(d1, runSql, kind)
      stmtResult = executed.results
      changes = executed.changes
      truncated = executed.truncated
    } catch (err) {
      errorMsg = err instanceof Error ? err.message : String(err)
    }

    const duration = Date.now() - start
    const rowCount = errorMsg ? 0 : changes !== undefined ? changes : stmtResult.length

    // Save to history (non-blocking)
    c.executionCtx.waitUntil(
      c.env.DB.prepare(
        `INSERT INTO ${T.query_history} (id, user_id, database_id, sql, duration_ms, row_count, error, executed_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`
      )
        .bind(uuid(), userId, db.id, sql, duration, rowCount, errorMsg ?? null, now())
        .run()
    )

    const entry: (typeof results)[number] = { sql, results: stmtResult, duration_ms: duration }
    if (changes !== undefined) entry.changes = changes
    if (errorMsg) entry.error = errorMsg
    if (truncated) entry.truncated = true
    results.push(entry)
  }

  // Save the run under its notebook (non-blocking)
  if (notebook?.seq != null) {
    const runId = uuid()
    c.executionCtx.waitUntil(
      saveRun(c.env, {
        id: runId,
        seq: notebook.seq,
        notebookId: notebook.id,
        userId,
        databaseId: db.id,
        sql: results.map((r) => r.sql).join(';\n'),
        statements: results,
        durationMs: Date.now() - executedAt,
        executedAt,
      })
    )
    return c.json({ results, run_id: runId, executed_at: executedAt, seq: notebook.seq })
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

  let rows: D1Result<Record<string, unknown>>
  if (dbId) {
    if (role === 'admin') {
      rows = await c.env.DB.prepare(
        `SELECT * FROM ${T.query_history} WHERE database_id = ?1 ORDER BY executed_at DESC LIMIT ?2 OFFSET ?3`
      )
        .bind(dbId, limit, offset)
        .all()
    } else {
      rows = await c.env.DB.prepare(
        `SELECT * FROM ${T.query_history} WHERE user_id = ?1 AND database_id = ?2 ORDER BY executed_at DESC LIMIT ?3 OFFSET ?4`
      )
        .bind(userId, dbId, limit, offset)
        .all()
    }
  } else {
    if (role === 'admin') {
      rows = await c.env.DB.prepare(`SELECT * FROM ${T.query_history} ORDER BY executed_at DESC LIMIT ?1 OFFSET ?2`)
        .bind(limit, offset)
        .all()
    } else {
      rows = await c.env.DB.prepare(
        `SELECT * FROM ${T.query_history} WHERE user_id = ?1 ORDER BY executed_at DESC LIMIT ?2 OFFSET ?3`
      )
        .bind(userId, limit, offset)
        .all()
    }
  }

  return c.json({ results: rows.results })
})

export default query
