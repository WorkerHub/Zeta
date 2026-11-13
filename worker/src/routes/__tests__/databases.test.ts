import { describe, expect, it } from 'vitest'
import { bearer, callWorker, fakeD1, fakeEnv } from './fakes'

const APP_DB = '11111111-1111-4111-8111-111111111111'
const DB_1 = '22222222-2222-4222-8222-222222222222'

// Two active registry rows: one targeting the application database, one an ordinary database
const rows = [
  {
    id: 'r1',
    name: 'app',
    description: null,
    binding_name: `cf:${APP_DB}`,
    cf_database_id: APP_DB,
    is_active: 1,
    created_at: 0,
    created_by: null,
  },
  {
    id: 'r2',
    name: 'logs',
    description: null,
    binding_name: `cf:${DB_1}`,
    cf_database_id: DB_1,
    is_active: 1,
    created_at: 0,
    created_by: null,
  },
]

function databasesEnv(storedPermissions: Record<string, string> = {}) {
  const { db } = fakeD1((sql) => {
    if (sql.includes('FROM d1_databases')) return rows
    if (sql.startsWith('SELECT database_id, permission')) {
      return Object.entries(storedPermissions).map(([database_id, permission]) => ({ database_id, permission }))
    }
    return null
  })
  return fakeEnv({ DB: db, ZETA_APP_DB_ID: APP_DB })
}

describe('GET /api/databases', () => {
  it('annotates every row with is_app_db', async () => {
    const env = databasesEnv()
    const res = await callWorker(env, '/api/databases', { headers: await bearer(env, 'a1', 'admin') })
    expect(res.status).toBe(200)
    const body = (await res.json()) as Array<{ id: string; is_app_db: boolean; permission: string }>
    const appRow = body.find((r) => r.id === 'r1')!
    const normalRow = body.find((r) => r.id === 'r2')!
    expect(appRow.is_app_db).toBe(true)
    expect(normalRow.is_app_db).toBe(false)
    // The admin's implicit write_drop is reported at its effective level on the app DB
    expect(appRow.permission).toBe('write')
    expect(normalRow.permission).toBe('write_drop')
  })

  it('never reports write_drop for the application database, whatever is stored', async () => {
    for (const stored of ['write_drop', 'write', 'read']) {
      const env = databasesEnv({ r1: stored })
      const res = await callWorker(env, '/api/databases', { headers: await bearer(env, 'u1') })
      expect(res.status).toBe(200)
      const body = (await res.json()) as Array<{ id: string; is_app_db: boolean; permission: string }>
      const appRow = body.find((r) => r.id === 'r1')!
      const normalRow = body.find((r) => r.id === 'r2')!
      expect(appRow.is_app_db).toBe(true)
      expect(appRow.permission).toBe(stored === 'write_drop' ? 'write' : stored)
      expect(normalRow.permission).toBe('read') // not granted → no access entry in permMap → read
    }
  })

  it('leaves ordinary databases untouched when no app DB row is registered', async () => {
    const { db } = fakeD1((sql) => {
      if (sql.includes('FROM d1_databases')) return [rows[1]]
      if (sql.startsWith('SELECT database_id, permission')) return [{ database_id: 'r2', permission: 'write_drop' }]
      return null
    })
    const env = fakeEnv({ DB: db, ZETA_APP_DB_ID: APP_DB })
    const res = await callWorker(env, '/api/databases', { headers: await bearer(env, 'u1') })
    expect(res.status).toBe(200)
    const body = (await res.json()) as Array<{ id: string; is_app_db: boolean; permission: string }>
    expect(body).toEqual([expect.objectContaining({ id: 'r2', is_app_db: false, permission: 'write_drop' })])
  })
})

describe('GET /api/databases (provider label)', () => {
  // A registration may name its own provider; without one the engine's is shown, and Spark has none.
  const withProviders = [
    { ...rows[1], id: 'pg', name: 'neon', kind: 'postgres', provider: 'Aiven' },
    { ...rows[1], id: 'my', name: 'tidb', kind: 'mysql', provider: null },
    { ...rows[1], id: 'sp', name: 'spark', kind: 'spark', provider: null },
    { ...rows[1], id: 'legacy', name: 'old', kind: undefined, provider: undefined },
  ]

  it('shows the effective provider and the stored text it came from, to a member too', async () => {
    const { db } = fakeD1((sql) => {
      if (sql.includes('FROM d1_databases')) return withProviders
      if (sql.startsWith('SELECT database_id, permission')) {
        return withProviders.map((row) => ({ database_id: row.id, permission: 'read' }))
      }
      return null
    })
    const env = fakeEnv({ DB: db, ZETA_APP_DB_ID: APP_DB })
    const res = await callWorker(env, '/api/databases', { headers: await bearer(env, 'u1') })
    expect(res.status).toBe(200)
    const body = (await res.json()) as Array<{ id: string; provider: string | null; provider_custom: string | null }>
    const byId = Object.fromEntries(body.map((row) => [row.id, row]))
    expect(byId.pg).toMatchObject({ provider: 'Aiven', provider_custom: 'Aiven' })
    expect(byId.my).toMatchObject({ provider: 'TiDB', provider_custom: null })
    expect(byId.sp).toMatchObject({ provider: null, provider_custom: null })
    // A row from before the kind column is a D1 target
    expect(byId.legacy).toMatchObject({ provider: 'D1', provider_custom: null })
  })
})
