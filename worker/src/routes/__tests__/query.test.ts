import { describe, it, expect } from 'vitest'
import { bearer, callWorker, fakeD1, fakeEnv, postJson } from './fakes'

// db1 is registered with a binding this Worker does not have
function queryEnv() {
  const { db } = fakeD1((sql) => {
    if (sql.startsWith('SELECT * FROM d1_databases')) return { id: 'db1', binding_name: 'QUERY_DB_9', is_active: 1 }
    if (sql.startsWith('SELECT permission FROM')) return { permission: 'read' }
    return null
  })
  return fakeEnv({ DB: db })
}

describe('query against a database whose binding is missing', () => {
  for (const [path, body] of [
    ['/api/query', { databaseId: 'db1', sql: 'SELECT 1' }],
    ['/api/query/batch', { databaseId: 'db1', statements: ['SELECT 1'] }],
  ] as const) {
    it(`${path}: does not reveal the binding name to members`, async () => {
      const env = queryEnv()
      const res = await callWorker(env, path, postJson(body, { headers: await bearer(env, 'u1') }))
      expect(res.status).toBe(500)
      expect(await res.json()).toEqual({ error: 'Database configuration error. Contact the admin.' })
    })

    it(`${path}: tells admins which binding is wrong`, async () => {
      const env = queryEnv()
      const res = await callWorker(env, path, postJson(body, { headers: await bearer(env, 'a1', 'admin') }))
      expect(res.status).toBe(500)
      expect(((await res.json()) as { error: string }).error).toContain('QUERY_DB_9')
    })
  }
})
