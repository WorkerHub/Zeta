import { Hono } from 'hono'
import type { Context } from 'hono'
import type { Env, Variables, NotebookRow, NotebookRunRow } from '../types'
import { requireAuth } from '../middleware/auth'
import { uuid } from '../lib/id'
import { now, tables } from '../lib/db'

const notebooks = new Hono<{ Bindings: Env; Variables: Variables }>()
notebooks.use('*', requireAuth)

const MAX_NOTEBOOKS = 20
const MAX_CONTENT_SIZE = 512 * 1024

// A notebook may only be bound to an active database the user can query (admins: any). Same
// rule as POST /api/query, and the same answer whether the id is unknown or just not granted.
async function canUseDatabase(
  c: Context<{ Bindings: Env; Variables: Variables }>,
  databaseId: unknown
): Promise<boolean> {
  if (databaseId === null) return true
  if (typeof databaseId !== 'string' || !databaseId) return false
  const T = tables(c.env)
  const row =
    c.get('userRole') === 'admin'
      ? await c.env.DB.prepare(`SELECT 1 FROM ${T.d1_databases} WHERE id = ?1 AND is_active = 1`)
          .bind(databaseId)
          .first()
      : await c.env.DB.prepare(
          `SELECT 1 FROM ${T.d1_databases} d
       JOIN ${T.user_database_permissions} p ON p.database_id = d.id
       WHERE d.id = ?1 AND d.is_active = 1 AND p.user_id = ?2`
        )
          .bind(databaseId, c.get('userId'))
          .first()
  return row !== null
}

const DATABASE_DENIED = 'Database not found or access denied'

// GET /api/notebooks
notebooks.get('/', async (c) => {
  const userId = c.get('userId')
  const T = tables(c.env)
  const rows = await c.env.DB.prepare(`SELECT * FROM ${T.notebooks} WHERE user_id = ?1 ORDER BY position ASC`)
    .bind(userId)
    .all<NotebookRow>()
  return c.json({ results: rows.results })
})

// POST /api/notebooks
notebooks.post('/', async (c) => {
  const userId = c.get('userId')
  const T = tables(c.env)
  const body: { name?: string; database_id?: string | null } = await c.req
    .json<{ name?: string; database_id?: string | null }>()
    .catch(() => ({}))
  const database_id = body.database_id ?? null
  if (!(await canUseDatabase(c, database_id))) return c.json({ error: DATABASE_DENIED }, 403)

  const count = await c.env.DB.prepare(`SELECT COUNT(*) as cnt FROM ${T.notebooks} WHERE user_id = ?1`)
    .bind(userId)
    .first<{ cnt: number }>()
  if ((count?.cnt ?? 0) >= MAX_NOTEBOOKS) {
    return c.json({ error: 'Maximum notebook limit reached' }, 400)
  }

  const maxPos = await c.env.DB.prepare(
    `SELECT COALESCE(MAX(position), -1) as max_pos FROM ${T.notebooks} WHERE user_id = ?1`
  )
    .bind(userId)
    .first<{ max_pos: number }>()

  const id = uuid()
  const ts = now()
  const name = body.name?.trim() || 'Untitled'
  const position = (maxPos?.max_pos ?? -1) + 1

  await c.env.DB.prepare(
    `INSERT INTO ${T.notebooks} (id, user_id, name, sql_content, database_id, position, created_at, updated_at)
     VALUES (?1, ?2, ?3, '', ?4, ?5, ?6, ?6)`
  )
    .bind(id, userId, name, database_id, position, ts)
    .run()

  return c.json(
    { id, user_id: userId, name, sql_content: '', database_id, position, created_at: ts, updated_at: ts },
    201
  )
})

// PATCH /api/notebooks/:id
notebooks.patch('/:id', async (c) => {
  const userId = c.get('userId')
  const notebookId = c.req.param('id')
  const T = tables(c.env)

  const existing = await c.env.DB.prepare(`SELECT id FROM ${T.notebooks} WHERE id = ?1 AND user_id = ?2`)
    .bind(notebookId, userId)
    .first()
  if (!existing) return c.json({ error: 'Notebook not found' }, 404)

  const body: {
    name?: string
    sql_content?: string
    database_id?: string | null
    position?: number
  } = await c.req
    .json<{
      name?: string
      sql_content?: string
      database_id?: string | null
      position?: number
    }>()
    .catch(() => ({}))

  const updates: string[] = ['updated_at = ?1']
  const bindings: unknown[] = [now()]
  let idx = 2

  if (body.name !== undefined) {
    updates.push(`name = ?${idx}`)
    bindings.push(body.name.trim() || 'Untitled')
    idx++
  }
  if (body.sql_content !== undefined) {
    if (body.sql_content.length > MAX_CONTENT_SIZE) {
      return c.json({ error: 'Content too large (max 512KB)' }, 400)
    }
    updates.push(`sql_content = ?${idx}`)
    bindings.push(body.sql_content)
    idx++
  }
  if ('database_id' in body) {
    if (!(await canUseDatabase(c, body.database_id ?? null))) return c.json({ error: DATABASE_DENIED }, 403)
    updates.push(`database_id = ?${idx}`)
    bindings.push(body.database_id ?? null)
    idx++
  }
  if (body.position !== undefined) {
    updates.push(`position = ?${idx}`)
    bindings.push(body.position)
    idx++
  }

  if (updates.length === 1) return c.json({ error: 'No fields to update' }, 400)

  bindings.push(notebookId)
  await c.env.DB.prepare(`UPDATE ${T.notebooks} SET ${updates.join(', ')} WHERE id = ?${idx}`)
    .bind(...bindings)
    .run()

  return c.json({ message: 'Updated' })
})

// DELETE /api/notebooks/:id
notebooks.delete('/:id', async (c) => {
  const userId = c.get('userId')
  const notebookId = c.req.param('id')
  const T = tables(c.env)

  const existing = await c.env.DB.prepare(`SELECT position FROM ${T.notebooks} WHERE id = ?1 AND user_id = ?2`)
    .bind(notebookId, userId)
    .first<{ position: number }>()
  if (!existing) return c.json({ error: 'Notebook not found' }, 404)

  // The "keep at least one" check is part of the DELETE itself: a separate COUNT first would let
  // two concurrent deletes (e.g. from two tabs) both see two notebooks and remove both.
  const deleted = await c.env.DB.prepare(
    `DELETE FROM ${T.notebooks} WHERE id = ?1 AND user_id = ?2
       AND (SELECT COUNT(*) FROM ${T.notebooks} WHERE user_id = ?2) > 1`
  )
    .bind(notebookId, userId)
    .run()
  if (!deleted.meta.changes) {
    const stillThere = await c.env.DB.prepare(`SELECT 1 FROM ${T.notebooks} WHERE id = ?1 AND user_id = ?2`)
      .bind(notebookId, userId)
      .first()
    return stillThere
      ? c.json({ error: 'Cannot delete the last notebook' }, 400)
      : c.json({ error: 'Notebook not found' }, 404)
  }

  await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE ${T.notebooks} SET position = position - 1 WHERE user_id = ?1 AND position > ?2`).bind(
      userId,
      existing.position
    ),
    // Also removed by ON DELETE CASCADE; explicit in case foreign keys are not enforced
    c.env.DB.prepare(`DELETE FROM ${T.notebook_runs} WHERE notebook_id = ?1`).bind(notebookId),
  ])

  return c.json({ message: 'Deleted' })
})

// ── Saved runs ────────────────────────────────────────────────────────────────
// Runs are saved by POST /api/query(/batch) (see lib/runs.ts). Only the notebook's owner sees
// them, and a run's results only while they can still query its database.

async function ownsNotebook(c: Context<{ Bindings: Env; Variables: Variables }>, notebookId: string) {
  const T = tables(c.env)
  const row = await c.env.DB.prepare(`SELECT 1 FROM ${T.notebooks} WHERE id = ?1 AND user_id = ?2`)
    .bind(notebookId, c.get('userId'))
    .first()
  return row !== null
}

const RUN_SUMMARY_COLUMNS = `r.id, r.seq, r.notebook_id, r.database_id, r.sql, r.statement_count, r.row_count, r.error_count,
  r.duration_ms, r.storage_truncated, r.results_bytes, r.executed_at`

type RunSummaryRow = Omit<NotebookRunRow, 'user_id' | 'results'> & { database_name: string | null }

// GET /api/notebooks/:id/runs — newest (highest number) first, without the results. Pages
// continue below the number given in `before` (else from `offset`), which stays right while runs
// are added or deleted in the meantime.
notebooks.get('/:id/runs', async (c) => {
  const notebookId = c.req.param('id')
  if (!(await ownsNotebook(c, notebookId))) return c.json({ error: 'Notebook not found' }, 404)
  const limit = Math.min(Math.max(parseInt(c.req.query('limit') ?? '50', 10) || 50, 1), 200)
  const offset = Math.max(parseInt(c.req.query('offset') ?? '0', 10) || 0, 0)
  const before = parseInt(c.req.query('before') ?? '', 10)
  const cursor = before > 0 ? ' AND r.seq < ?5' : ''
  const T = tables(c.env)

  // One row more than asked tells whether there are more
  const stmt = c.env.DB.prepare(
    `SELECT ${RUN_SUMMARY_COLUMNS}, d.name AS database_name
     FROM ${T.notebook_runs} r LEFT JOIN ${T.d1_databases} d ON d.id = r.database_id
     WHERE r.notebook_id = ?1 AND r.user_id = ?2${cursor}
     ORDER BY r.seq DESC LIMIT ?3 OFFSET ?4`
  )
  const rows = await (cursor
    ? stmt.bind(notebookId, c.get('userId'), limit + 1, 0, before)
    : stmt.bind(notebookId, c.get('userId'), limit + 1, offset)
  ).all<RunSummaryRow>()

  const access = new Map<string, boolean>()
  for (const id of new Set(rows.results.map((r) => r.database_id))) access.set(id, await canUseDatabase(c, id))

  return c.json({
    results: rows.results.slice(0, limit).map((r) => ({ ...r, accessible: access.get(r.database_id) ?? false })),
    has_more: rows.results.length > limit,
  })
})

// GET /api/notebooks/:id/runs/:runId — one run with its results
notebooks.get('/:id/runs/:runId', async (c) => {
  const notebookId = c.req.param('id')
  if (!(await ownsNotebook(c, notebookId))) return c.json({ error: 'Notebook not found' }, 404)
  const T = tables(c.env)
  const run = await c.env.DB.prepare(
    `SELECT ${RUN_SUMMARY_COLUMNS}, r.results, d.name AS database_name
     FROM ${T.notebook_runs} r LEFT JOIN ${T.d1_databases} d ON d.id = r.database_id
     WHERE r.id = ?1 AND r.notebook_id = ?2 AND r.user_id = ?3`
  )
    .bind(c.req.param('runId'), notebookId, c.get('userId'))
    .first<RunSummaryRow & { results: string }>()
  if (!run) return c.json({ error: 'Run not found' }, 404)
  // Re-checked on every read: results stay hidden once the user loses access to the database
  if (!(await canUseDatabase(c, run.database_id))) return c.json({ error: 'Database access denied' }, 403)

  let results: unknown = []
  try {
    results = JSON.parse(run.results)
  } catch {
    /* corrupt row: show the run without results */
  }
  return c.json({ ...run, accessible: true, results })
})

// DELETE /api/notebooks/:id/runs/:runId
notebooks.delete('/:id/runs/:runId', async (c) => {
  const notebookId = c.req.param('id')
  if (!(await ownsNotebook(c, notebookId))) return c.json({ error: 'Notebook not found' }, 404)
  const T = tables(c.env)
  const res = await c.env.DB.prepare(`DELETE FROM ${T.notebook_runs} WHERE id = ?1 AND notebook_id = ?2`)
    .bind(c.req.param('runId'), notebookId)
    .run()
  if (!res.meta.changes) return c.json({ error: 'Run not found' }, 404)
  return c.json({ message: 'Deleted' })
})

// DELETE /api/notebooks/:id/runs — clear all of the notebook's runs
notebooks.delete('/:id/runs', async (c) => {
  const notebookId = c.req.param('id')
  if (!(await ownsNotebook(c, notebookId))) return c.json({ error: 'Notebook not found' }, 404)
  const T = tables(c.env)
  await c.env.DB.prepare(`DELETE FROM ${T.notebook_runs} WHERE notebook_id = ?1`).bind(notebookId).run()
  return c.json({ message: 'Cleared' })
})

export default notebooks
