import { describe, it, expect, afterEach, vi } from 'vitest'
import { bearer, callWorker, fakeD1, fakeEnv, postJson } from './fakes'

const APP_DB = '11111111-1111-4111-8111-111111111111'
const DB_1 = '22222222-2222-4222-8222-222222222222'

afterEach(() => vi.unstubAllGlobals())

// db1 is registered but not linked to a Cloudflare database (no cf_database_id)
function queryEnv() {
  const { db } = fakeD1((sql) => {
    if (sql.startsWith('SELECT * FROM d1_databases')) return { id: 'db1', binding_name: 'QUERY_DB_9', is_active: 1 }
    if (sql.startsWith('SELECT permission FROM')) return { permission: 'read' }
    return null
  })
  return fakeEnv({ DB: db })
}

// db1 is registered against a Cloudflare database (HTTP path)
function httpQueryEnv() {
  const { db } = fakeD1((sql) => {
    if (sql.startsWith('SELECT * FROM d1_databases'))
      return { id: 'db1', name: 'n', description: null, binding_name: `cf:${DB_1}`, cf_database_id: DB_1, is_active: 1 }
    if (sql.startsWith('SELECT permission FROM')) return { permission: 'read' }
    return null
  })
  return fakeEnv({ DB: db, CF_ACCOUNT_ID: 'acct', CF_D1_API_TOKEN: 'tok', ZETA_APP_DB_ID: APP_DB })
}

const fetchOk = (result: unknown) =>
  vi
    .fn()
    .mockResolvedValue(
      new Response(JSON.stringify(result), { status: 200, headers: { 'Content-Type': 'application/json' } })
    )

describe('query against a database that is not linked', () => {
  for (const [path, body] of [
    ['/api/query', { databaseId: 'db1', sql: 'SELECT 1' }],
    ['/api/query/batch', { databaseId: 'db1', statements: ['SELECT 1'] }],
  ] as const) {
    it(`${path}: does not reveal the missing link to members`, async () => {
      const env = queryEnv()
      const res = await callWorker(env, path, postJson(body, { headers: await bearer(env, 'u1') }))
      expect(res.status).toBe(500)
      expect(await res.json()).toEqual({ error: 'Database configuration error. Contact the admin.' })
    })

    it(`${path}: tells admins the database is not linked`, async () => {
      const env = queryEnv()
      const res = await callWorker(env, path, postJson(body, { headers: await bearer(env, 'a1', 'admin') }))
      expect(res.status).toBe(500)
      expect(((await res.json()) as { error: string }).error).toContain('not linked')
    })
  }
})

describe('query over the D1 HTTP API', () => {
  it('executes a read via the HTTP API and returns its rows', async () => {
    const env = httpQueryEnv()
    const fetchMock = fetchOk({ success: true, result: [{ success: true, results: [{ n: 1 }], meta: { changes: 0 } }] })
    vi.stubGlobal('fetch', fetchMock)
    const res = await callWorker(
      env,
      '/api/query',
      postJson({ databaseId: 'db1', sql: 'SELECT 1' }, { headers: await bearer(env, 'u1') })
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { results: unknown[] }
    expect(body.results).toEqual([{ n: 1 }])
    expect(String(fetchMock.mock.calls[0]![0])).toContain(`/d1/database/${DB_1}/query`)
  })

  it('rejects a forbidden statement before calling the HTTP API', async () => {
    const env = httpQueryEnv()
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const res = await callWorker(
      env,
      '/api/query',
      postJson({ databaseId: 'db1', sql: 'ATTACH DATABASE x' }, { headers: await bearer(env, 'u1') })
    )
    expect(res.status).toBe(403)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects multiple statements before calling the HTTP API', async () => {
    const env = httpQueryEnv()
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const res = await callWorker(
      env,
      '/api/query',
      postJson({ databaseId: 'db1', sql: 'SELECT 1; SELECT 2' }, { headers: await bearer(env, 'u1') })
    )
    expect(res.status).toBe(400)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects a write for a read-only member before calling the HTTP API', async () => {
    const env = httpQueryEnv()
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const res = await callWorker(
      env,
      '/api/query',
      postJson({ databaseId: 'db1', sql: 'DELETE FROM t' }, { headers: await bearer(env, 'u1') })
    )
    expect(res.status).toBe(403)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('caps reads at 5000 rows in the SQL sent over HTTP', async () => {
    const env = httpQueryEnv()
    const fetchMock = fetchOk({ success: true, result: [{ success: true, results: [], meta: {} }] })
    vi.stubGlobal('fetch', fetchMock)
    await callWorker(
      env,
      '/api/query',
      postJson({ databaseId: 'db1', sql: 'SELECT * FROM t' }, { headers: await bearer(env, 'u1') })
    )
    const sent = JSON.parse(String(fetchMock.mock.calls[0]![1]!.body)) as { sql: string }
    expect(sent.sql).toMatch(/LIMIT 5001/)
  })

  it('returns a config error to members when credentials are missing', async () => {
    const env = httpQueryEnv()
    env.CF_D1_API_TOKEN = ''
    const res = await callWorker(
      env,
      '/api/query',
      postJson({ databaseId: 'db1', sql: 'SELECT 1' }, { headers: await bearer(env, 'u1') })
    )
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'Database configuration error. Contact the admin.' })
  })

  it('tells admins which credential is missing', async () => {
    const env = httpQueryEnv()
    env.CF_D1_API_TOKEN = ''
    const res = await callWorker(
      env,
      '/api/query',
      postJson({ databaseId: 'db1', sql: 'SELECT 1' }, { headers: await bearer(env, 'a1', 'admin') })
    )
    expect(res.status).toBe(500)
    expect(((await res.json()) as { error: string }).error).toContain('CF_D1_API_TOKEN')
  })

  it('refuses to query the application database over HTTP', async () => {
    const env = httpQueryEnv()
    // Re-register db1 as the app DB
    const { db } = fakeD1((sql) => {
      if (sql.startsWith('SELECT * FROM d1_databases'))
        return {
          id: 'db1',
          name: 'n',
          description: null,
          binding_name: `cf:${APP_DB}`,
          cf_database_id: APP_DB,
          is_active: 1,
        }
      if (sql.startsWith('SELECT permission FROM')) return { permission: 'read' }
      return null
    })
    env.DB = db
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const res = await callWorker(
      env,
      '/api/query',
      postJson({ databaseId: 'db1', sql: 'SELECT 1' }, { headers: await bearer(env, 'u1') })
    )
    expect(res.status).toBe(500)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
