import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Env } from '../../types'
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

describe('application database as a query target (ALLOW_APP_DB_AS_TARGET)', () => {
  // db1 is registered as the application database itself, with the switch on
  function appDbEnv(overrides: Partial<Env> = {}, storedPermission = 'read') {
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
      if (sql.startsWith('SELECT permission FROM')) return { permission: storedPermission }
      return null
    })
    return fakeEnv({
      DB: db,
      CF_ACCOUNT_ID: 'acct',
      CF_D1_API_TOKEN: 'tok',
      ZETA_APP_DB_ID: APP_DB,
      ALLOW_APP_DB_AS_TARGET: 'true',
      ...overrides,
    })
  }

  // Runs one statement through both the single and the batch path and normalises the outcome:
  // `{ ok, error }` per path — the single path answers with a status + { error }, the batch path
  // answers 200 with per-statement entries (error set when rejected) or a plain { error } for
  // target-resolution failures.
  async function runStatement(env: Env, sql: string, headers: Record<string, string>) {
    const single = await callWorker(env, '/api/query', postJson({ databaseId: 'db1', sql }, { headers }))
    const batch = await callWorker(
      env,
      '/api/query/batch',
      postJson({ databaseId: 'db1', statements: [sql] }, { headers })
    )
    const singleBody = (await single.json()) as { error?: string }
    const batchBody = (await batch.json()) as { error?: string; results?: Array<{ error?: string }> }
    return {
      single: { status: single.status, error: singleBody.error },
      batch: { status: batch.status, error: batchBody.results?.[0]?.error ?? batchBody.error },
    }
  }

  // A fetch mock that answers every call with a fresh Response (a Response body can be read once)
  const fetchOkEach = (result: unknown) =>
    vi.fn((_url: unknown, _init: unknown) =>
      Promise.resolve(
        new Response(JSON.stringify(result), { status: 200, headers: { 'Content-Type': 'application/json' } })
      )
    )

  it('lets an admin SELECT an internal table and write a non-internal table', async () => {
    const env = appDbEnv()
    const fetchMock = fetchOkEach({ success: true, result: [{ success: true, results: [], meta: {} }] })
    vi.stubGlobal('fetch', fetchMock)
    const headers = await bearer(env, 'a1', 'admin')
    for (const sql of [
      'SELECT * FROM users',
      'INSERT INTO logs (a) VALUES (1)',
      'UPDATE logs SET a = 1',
      'DELETE FROM logs',
    ]) {
      const { single, batch } = await runStatement(env, sql, headers)
      expect(single.status, sql).toBe(200)
      expect(single.error, sql).toBeUndefined()
      expect(batch.status, sql).toBe(200)
      expect(batch.error, sql).toBeUndefined()
    }
    // The statements really ran against the application database over the HTTP API
    expect(fetchMock).toHaveBeenCalled()
    for (const call of fetchMock.mock.calls) expect(String(call[0])).toContain(`/d1/database/${APP_DB}/query`)
  })

  it('rejects destructive statements for everyone on the application database', async () => {
    for (const [role, stored] of [
      ['admin', 'read'],
      ['member', 'write_drop'],
    ] as const) {
      const env = appDbEnv({}, stored)
      const fetchMock = vi.fn()
      vi.stubGlobal('fetch', fetchMock)
      const headers = await bearer(env, role === 'admin' ? 'a1' : 'u1', role)
      const { single, batch } = await runStatement(env, 'DROP TABLE logs', headers)
      expect(single.status).toBe(403)
      expect(single.error).toMatch(/elevated permissions/)
      expect(batch.status).toBe(200)
      expect(batch.error).toMatch(/elevated permissions/)
      expect(fetchMock).not.toHaveBeenCalled()
    }
  })

  it('rejects writes against internal tables, admin included, on both paths', async () => {
    const env = appDbEnv()
    const headers = await bearer(env, 'a1', 'admin')
    for (const sql of [
      'INSERT INTO users (email) VALUES (1)',
      'UPDATE users SET name = 1',
      'DELETE FROM users',
      'REPLACE INTO users VALUES (1)',
      'ALTER TABLE users ADD COLUMN b',
      'WITH a AS (SELECT 1) DELETE FROM users',
    ]) {
      const fetchMock = vi.fn()
      vi.stubGlobal('fetch', fetchMock)
      const { single, batch } = await runStatement(env, sql, headers)
      expect(single.status, sql).toBe(403)
      expect(single.error, sql).toMatch(/application internal table/i)
      expect(batch.status, sql).toBe(200)
      expect(batch.error, sql).toMatch(/application internal table/i)
      expect(fetchMock, sql).not.toHaveBeenCalled()
    }
  })

  it('rejects writes whose target table cannot be determined on the application database', async () => {
    const env = appDbEnv()
    const headers = await bearer(env, 'a1', 'admin')
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const { single, batch } = await runStatement(env, 'VACUUM', headers)
    expect(single.status).toBe(403)
    expect(single.error).toMatch(/cannot be determined/i)
    expect(batch.error).toMatch(/cannot be determined/i)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('caps a stored write_drop at write for members on the application database', async () => {
    const env = appDbEnv({}, 'write_drop')
    const fetchMock = fetchOkEach({ success: true, result: [{ success: true, results: [], meta: {} }] })
    vi.stubGlobal('fetch', fetchMock)
    const headers = await bearer(env, 'u1')
    // A write within `write` still runs…
    const insert = await runStatement(env, 'INSERT INTO logs (a) VALUES (1)', headers)
    expect(insert.single.status).toBe(200)
    expect(insert.batch.error).toBeUndefined()
    // …and destructive statements are refused without write_drop
    const drop = await runStatement(env, 'TRUNCATE logs', headers)
    expect(drop.single.status).toBe(403)
    expect(drop.batch.error).toMatch(/elevated permissions/)
  })

  it('rejects the registered application-database row again once the switch is turned off', async () => {
    const env = appDbEnv({ ALLOW_APP_DB_AS_TARGET: 'false' })
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const headers = await bearer(env, 'a1', 'admin')
    const { single, batch } = await runStatement(env, 'SELECT * FROM users', headers)
    expect(single.status).toBe(500)
    expect(single.error).toContain('application database')
    expect(batch.status).toBe(500)
    expect(batch.error).toContain('application database')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('fails closed on a missing ZETA_APP_DB_ID even with the switch on', async () => {
    const env = appDbEnv({ ZETA_APP_DB_ID: '' })
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const headers = await bearer(env, 'a1', 'admin')
    const { single, batch } = await runStatement(env, 'SELECT 1', headers)
    expect(single.status).toBe(500)
    expect(single.error).toContain('ZETA_APP_DB_ID')
    expect(batch.status).toBe(500)
    expect(batch.error).toContain('ZETA_APP_DB_ID')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
