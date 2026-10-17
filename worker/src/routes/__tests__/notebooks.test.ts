import { describe, it, expect } from 'vitest'
import { bearer, callWorker, fakeD1, fakeEnv, postJson } from './fakes'

// db-granted: member u1 has a permission row; db-other: exists but not granted; db-off: inactive
function notebooksEnv() {
  const { db, calls } = fakeD1((sql, args) => {
    if (sql.startsWith('SELECT id FROM notebooks WHERE id')) return { id: args[0] }
    if (sql.startsWith('SELECT COUNT(*)')) return { cnt: 1 }
    if (sql.startsWith('SELECT COALESCE(MAX(position)')) return { max_pos: 0 }
    if (sql.startsWith('SELECT 1 FROM d1_databases d')) {
      return args[0] === 'db-granted' && args[1] === 'u1' ? { 1: 1 } : null
    }
    if (sql.startsWith('SELECT 1 FROM d1_databases WHERE')) {
      return args[0] === 'db-granted' || args[0] === 'db-other' ? { 1: 1 } : null
    }
    return null
  })
  return { env: fakeEnv({ DB: db }), calls }
}

const patch = (body: unknown, headers: Record<string, string>): RequestInit =>
  postJson(body, { method: 'PATCH', headers })
const wrote = (calls: { sql: string }[]) =>
  calls.some((c) => c.sql.startsWith('INSERT INTO notebooks') || c.sql.startsWith('UPDATE notebooks'))

describe('notebook database binding', () => {
  it('refuses to create a notebook bound to a database the member cannot access', async () => {
    const { env, calls } = notebooksEnv()
    const headers = await bearer(env, 'u1')
    for (const database_id of ['db-other', 'db-off', 'missing', 42]) {
      const res = await callWorker(env, '/api/notebooks', postJson({ database_id }, { headers }))
      expect(res.status).toBe(403)
    }
    expect(wrote(calls)).toBe(false)
  })

  it('creates notebooks bound to a granted database or to none', async () => {
    const { env } = notebooksEnv()
    const headers = await bearer(env, 'u1')
    expect((await callWorker(env, '/api/notebooks', postJson({ database_id: 'db-granted' }, { headers }))).status).toBe(
      201
    )
    expect((await callWorker(env, '/api/notebooks', postJson({}, { headers }))).status).toBe(201)
  })

  it('applies the same check when re-binding an existing notebook', async () => {
    const { env, calls } = notebooksEnv()
    const headers = await bearer(env, 'u1')
    expect((await callWorker(env, '/api/notebooks/nb1', patch({ database_id: 'db-other' }, headers))).status).toBe(403)
    expect(wrote(calls)).toBe(false)
    expect((await callWorker(env, '/api/notebooks/nb1', patch({ database_id: 'db-granted' }, headers))).status).toBe(
      200
    )
    expect((await callWorker(env, '/api/notebooks/nb1', patch({ database_id: null }, headers))).status).toBe(200)
  })

  it('lets admins bind any active database', async () => {
    const { env } = notebooksEnv()
    const headers = await bearer(env, 'admin-1', 'admin')
    expect((await callWorker(env, '/api/notebooks/nb1', patch({ database_id: 'db-other' }, headers))).status).toBe(200)
    expect((await callWorker(env, '/api/notebooks/nb1', patch({ database_id: 'db-off' }, headers))).status).toBe(403)
  })
})

describe('DELETE /api/notebooks/:id', () => {
  // `others`: how many other notebooks the user has when the DELETE runs; `vanished`: another
  // request deleted this notebook between the ownership check and the DELETE.
  function deleteEnv({ others, vanished = false }: { others: number; vanished?: boolean }) {
    const { db, calls } = fakeD1((sql) => {
      if (sql.startsWith('SELECT position FROM notebooks')) return { position: 2 }
      if (sql.startsWith('SELECT 1 FROM notebooks')) return vanished ? null : { 1: 1 }
      if (sql.startsWith('DELETE FROM notebooks')) return { changes: !vanished && others > 0 ? 1 : 0 }
      return null
    })
    return { env: fakeEnv({ DB: db }), calls }
  }
  const del = async (env: ReturnType<typeof fakeEnv>) =>
    callWorker(env, '/api/notebooks/nb1', { method: 'DELETE', headers: await bearer(env, 'u1') })

  it('checks "not the last one" inside the DELETE, so concurrent deletes cannot both pass', async () => {
    const { env, calls } = deleteEnv({ others: 1 })
    expect((await del(env)).status).toBe(200)
    const stmt = calls.find((c) => c.sql.startsWith('DELETE FROM notebooks'))!
    expect(stmt.sql).toMatch(/AND user_id = \?2\s+AND \(SELECT COUNT\(\*\) FROM notebooks WHERE user_id = \?2\) > 1/)
    expect(calls.some((c) => c.sql.startsWith('UPDATE notebooks SET position'))).toBe(true)
  })

  it('refuses to delete the last notebook and leaves positions alone', async () => {
    const { env, calls } = deleteEnv({ others: 0 })
    const res = await del(env)
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'Cannot delete the last notebook' })
    expect(calls.some((c) => c.sql.startsWith('UPDATE notebooks'))).toBe(false)
  })

  it('answers 404 when a concurrent request already deleted it', async () => {
    const { env } = deleteEnv({ others: 1, vanished: true })
    expect((await del(env)).status).toBe(404)
  })
})
