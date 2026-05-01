import { Hono } from 'hono'
import type { Env, Variables, NotebookRow } from '../types'
import { requireAuth } from '../middleware/auth'
import { uuid } from '../lib/id'
import { now, tables } from '../lib/db'

const notebooks = new Hono<{ Bindings: Env; Variables: Variables }>()
notebooks.use('*', requireAuth)

const MAX_NOTEBOOKS = 20

// GET /api/notebooks
notebooks.get('/', async (c) => {
  const userId = c.get('userId')
  const T = tables(c.env)
  const rows = await c.env.DB.prepare(
    `SELECT * FROM ${T.notebooks} WHERE user_id = ?1 ORDER BY position ASC`
  ).bind(userId).all<NotebookRow>()
  return c.json({ results: rows.results })
})

// POST /api/notebooks
notebooks.post('/', async (c) => {
  const userId = c.get('userId')
  const T = tables(c.env)
  const body: { name?: string; database_id?: string } = await c.req.json<{ name?: string; database_id?: string }>().catch(() => ({}))

  const count = await c.env.DB.prepare(
    `SELECT COUNT(*) as cnt FROM ${T.notebooks} WHERE user_id = ?1`
  ).bind(userId).first<{ cnt: number }>()
  if ((count?.cnt ?? 0) >= MAX_NOTEBOOKS) {
    return c.json({ error: 'Maximum notebook limit reached' }, 400)
  }

  const maxPos = await c.env.DB.prepare(
    `SELECT COALESCE(MAX(position), -1) as max_pos FROM ${T.notebooks} WHERE user_id = ?1`
  ).bind(userId).first<{ max_pos: number }>()

  const id = uuid()
  const ts = now()
  const name = body.name?.trim() || 'Untitled'
  const database_id = body.database_id ?? null
  const position = (maxPos?.max_pos ?? -1) + 1

  await c.env.DB.prepare(
    `INSERT INTO ${T.notebooks} (id, user_id, name, sql_content, database_id, position, created_at, updated_at)
     VALUES (?1, ?2, ?3, '', ?4, ?5, ?6, ?6)`
  ).bind(id, userId, name, database_id, position, ts).run()

  return c.json({ id, user_id: userId, name, sql_content: '', database_id, position, created_at: ts, updated_at: ts }, 201)
})

// PATCH /api/notebooks/:id
notebooks.patch('/:id', async (c) => {
  const userId = c.get('userId')
  const notebookId = c.req.param('id')
  const T = tables(c.env)

  const existing = await c.env.DB.prepare(
    `SELECT id FROM ${T.notebooks} WHERE id = ?1 AND user_id = ?2`
  ).bind(notebookId, userId).first()
  if (!existing) return c.json({ error: 'Notebook not found' }, 404)

  const body: {
    name?: string
    sql_content?: string
    database_id?: string | null
    position?: number
  } = await c.req.json<{
    name?: string
    sql_content?: string
    database_id?: string | null
    position?: number
  }>().catch(() => ({}))

  const updates: string[] = ['updated_at = ?1']
  const bindings: unknown[] = [now()]
  let idx = 2

  if (body.name !== undefined) {
    updates.push(`name = ?${idx}`)
    bindings.push(body.name.trim() || 'Untitled')
    idx++
  }
  if (body.sql_content !== undefined) {
    updates.push(`sql_content = ?${idx}`)
    bindings.push(body.sql_content)
    idx++
  }
  if ('database_id' in body) {
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
  await c.env.DB.prepare(
    `UPDATE ${T.notebooks} SET ${updates.join(', ')} WHERE id = ?${idx}`
  ).bind(...bindings).run()

  return c.json({ message: 'Updated' })
})

// DELETE /api/notebooks/:id
notebooks.delete('/:id', async (c) => {
  const userId = c.get('userId')
  const notebookId = c.req.param('id')
  const T = tables(c.env)

  const existing = await c.env.DB.prepare(
    `SELECT position FROM ${T.notebooks} WHERE id = ?1 AND user_id = ?2`
  ).bind(notebookId, userId).first<{ position: number }>()
  if (!existing) return c.json({ error: 'Notebook not found' }, 404)

  await c.env.DB.prepare(
    `DELETE FROM ${T.notebooks} WHERE id = ?1`
  ).bind(notebookId).run()

  // Re-sequence positions for remaining notebooks
  await c.env.DB.prepare(
    `UPDATE ${T.notebooks} SET position = position - 1 WHERE user_id = ?1 AND position > ?2`
  ).bind(userId, existing.position).run()

  return c.json({ message: 'Deleted' })
})

export default notebooks
