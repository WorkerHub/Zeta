import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Env } from '../../types'
import { bearer, callWorker, fakeD1, fakeEnv, postJson } from './fakes'

// POST /api/query/batch stops at the first failure: a statement rejected before it runs (MySQL
// translation error, permission check, application-database guardrail) or one that fails while
// running ends the batch with its own result kept, and the response says `halted: true`. A batch
// that runs to the end answers `halted: false` — the field is always there.

const APP_DB = '11111111-1111-4111-8111-111111111111'
const DB_1 = '22222222-2222-4222-8222-222222222222'

afterEach(() => vi.unstubAllGlobals())

// db1 is registered and linked, reached over the D1 HTTP API; every statement sent to D1 is a call
// of the fetch stub, so a statement that never ran is one call that never happened.
function batchEnv(opts: { permission?: string; appDb?: boolean } = {}) {
  const target = opts.appDb ? APP_DB : DB_1
  const { db } = fakeD1((sql) => {
    if (sql.startsWith('SELECT * FROM d1_databases'))
      return {
        id: 'db1',
        name: 'n',
        description: null,
        binding_name: `cf:${target}`,
        cf_database_id: target,
        is_active: 1,
      }
    if (sql.startsWith('SELECT permission FROM')) return { permission: opts.permission ?? 'read' }
    return null
  })
  return fakeEnv({
    DB: db,
    CF_ACCOUNT_ID: 'acct',
    CLOUDFLARE_API_TOKEN: 'tok',
    ZETA_APP_DB_ID: APP_DB,
    ...(opts.appDb ? { ALLOW_APP_DB_AS_TARGET: 'true' } : {}),
  })
}

const jsonResponse = (payload: unknown) =>
  new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } })

// A statement the D1 HTTP API reports as run, with `n` as its only value
const d1Ok = (n: number) => ({ success: true, result: [{ success: true, results: [{ n }], meta: {} }] })
// A statement the API rejects: HTTP 200 with the error in the top-level array (see lib/d1-http.ts)
const d1Error = (message: string) => ({ success: true, result: [{ success: false, meta: {} }], errors: [{ message }] })

// The stub answers one queued D1 response per call, so an extra answer that was never asked for
// proves the batch stopped early.
function fetchScript(...answers: unknown[]) {
  const mock = vi.fn()
  for (const answer of answers) mock.mockResolvedValueOnce(jsonResponse(answer))
  return mock
}

async function batch(
  env: Env,
  statements: string[],
  userId = 'u1',
  role: 'admin' | 'member' = 'member'
): Promise<{ status: number; body: { results: Array<{ sql: string; error?: string }>; halted?: boolean } }> {
  const res = await callWorker(
    env,
    '/api/query/batch',
    postJson({ databaseId: 'db1', statements }, { headers: await bearer(env, userId, role) })
  )
  return { status: res.status, body: (await res.json()) as never }
}

describe('batch execution stops at the first failure', () => {
  it('stops at a statement that fails while running, keeping its result', async () => {
    const env = batchEnv()
    const fetchMock = fetchScript(d1Ok(1), d1Error('no such table: t'), d1Ok(3))
    vi.stubGlobal('fetch', fetchMock)

    const { status, body } = await batch(env, ['SELECT 1', 'SELECT * FROM t', 'SELECT 3'])

    expect(status).toBe(200)
    expect(body.results).toHaveLength(2)
    expect(body.results[0]).toMatchObject({ sql: 'SELECT 1' })
    expect(body.results[0]!.error).toBeUndefined()
    expect(body.results[1]).toMatchObject({ sql: 'SELECT * FROM t', error: 'no such table: t' })
    expect(body.halted).toBe(true)
    // The third statement was never sent to the database
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('stops at a statement the permission check rejects before it runs', async () => {
    const env = batchEnv({ permission: 'read' })
    const fetchMock = fetchScript(d1Ok(1), d1Ok(2), d1Ok(3))
    vi.stubGlobal('fetch', fetchMock)

    const { status, body } = await batch(env, ['DELETE FROM t', 'SELECT 1', 'SELECT 2'])

    expect(status).toBe(200)
    expect(body.results).toHaveLength(1)
    expect(body.results[0]!.error).toMatch(/read access/)
    expect(body.halted).toBe(true)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('stops at a statement the MySQL compatibility rewrite rejects', async () => {
    const env = batchEnv()
    const fetchMock = fetchScript(d1Ok(1), d1Ok(3))
    vi.stubGlobal('fetch', fetchMock)

    // SHOW DATABASES is recognised but has no SQLite equivalent (see lib/mysql-compat.ts)
    const { body } = await batch(env, ['SELECT 1', 'SHOW DATABASES', 'SELECT 3'])

    expect(body.results).toHaveLength(2)
    expect(body.results[1]!.error).toBeTruthy()
    expect(body.halted).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('stops at a write the application-database guardrail rejects', async () => {
    const env = batchEnv({ appDb: true })
    const fetchMock = fetchScript(d1Ok(1), d1Ok(3))
    vi.stubGlobal('fetch', fetchMock)

    const { body } = await batch(env, ['SELECT 1', 'INSERT INTO users (email) VALUES (1)', 'SELECT 3'], 'a1', 'admin')

    expect(body.results).toHaveLength(2)
    expect(body.results[1]!.error).toMatch(/application internal table/i)
    expect(body.halted).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('batch execution that runs to the end', () => {
  it('runs every statement and answers halted: false', async () => {
    const env = batchEnv()
    const fetchMock = fetchScript(d1Ok(1), d1Ok(2), d1Ok(3))
    vi.stubGlobal('fetch', fetchMock)

    const { status, body } = await batch(env, ['SELECT 1', 'SELECT 2', 'SELECT 3'])

    expect(status).toBe(200)
    expect(body.results).toHaveLength(3)
    // The field is always present, never omitted, so a client can read it as a boolean
    expect(body).toHaveProperty('halted', false)
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('skips blank statements without halting', async () => {
    const env = batchEnv()
    const fetchMock = fetchScript(d1Ok(1), d1Ok(2))
    vi.stubGlobal('fetch', fetchMock)

    const { body } = await batch(env, ['SELECT 1', '   ', 'SELECT 2'])

    expect(body.results.map((r) => r.sql)).toEqual(['SELECT 1', 'SELECT 2'])
    expect(body.halted).toBe(false)
  })
})
