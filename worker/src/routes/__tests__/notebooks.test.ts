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
    expect((await callWorker(env, '/api/notebooks', postJson({ database_id: 'db-granted' }, { headers }))).status).toBe(201)
    expect((await callWorker(env, '/api/notebooks', postJson({}, { headers }))).status).toBe(201)
  })

  it('applies the same check when re-binding an existing notebook', async () => {
    const { env, calls } = notebooksEnv()
    const headers = await bearer(env, 'u1')
    expect((await callWorker(env, '/api/notebooks/nb1', patch({ database_id: 'db-other' }, headers))).status).toBe(403)
    expect(wrote(calls)).toBe(false)
    expect((await callWorker(env, '/api/notebooks/nb1', patch({ database_id: 'db-granted' }, headers))).status).toBe(200)
    expect((await callWorker(env, '/api/notebooks/nb1', patch({ database_id: null }, headers))).status).toBe(200)
  })

  it('lets admins bind any active database', async () => {
    const { env } = notebooksEnv()
    const headers = await bearer(env, 'admin-1', 'admin')
    expect((await callWorker(env, '/api/notebooks/nb1', patch({ database_id: 'db-other' }, headers))).status).toBe(200)
    expect((await callWorker(env, '/api/notebooks/nb1', patch({ database_id: 'db-off' }, headers))).status).toBe(403)
  })
})
