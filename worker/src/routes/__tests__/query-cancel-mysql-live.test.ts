import { afterEach, describe, expect, it, vi } from 'vitest'
import { getMigrations } from '../../lib/migrations'
import { sealSecret } from '../../lib/secrets'
import type { Env } from '../../types'
import { bearer, callWorker, fakeEnv, postJson } from './fakes'
import { sqliteD1 } from './sqlite-d1'

// Opt-in live test for cancellation against a real TiDB Cloud Starter instance (the team's
// connection string; environment only, never the repo).
//
//   TIDB_URL=… pnpm test -- query-cancel-mysql-live
//
// It pins what the ruling decided for this engine: there is **no** kill channel (KILL is rejected by
// the endpoint, and a client abort does not stop the server), so a cancellation only sets the flag —
// the statement that is already running completes, and the statements after it never start.
// It only reads (`select sleep(…)`), so it touches no data.
const LIVE_URL = process.env.TIDB_URL ?? ''

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

afterEach(() => vi.unstubAllGlobals())

describe.skipIf(!LIVE_URL)('TiDB cancellation against a live instance', () => {
  // The app database is a real in-memory SQLite with the production schema, so the registry,
  // permission and history statements all run for real; only the query target is remote.
  async function liveEnv(): Promise<Env> {
    const app = sqliteD1()
    for (const migration of getMigrations({ TABLE_PREFIX: '' })) app.sqlite.exec(migration.sql)
    const env = fakeEnv({ DB: app.db })
    const sealed = await sealSecret(env, JSON.stringify({ url: LIVE_URL }))
    app.sqlite.exec(`
      INSERT INTO users (id, email, name, role, created_at, updated_at)
        VALUES ('a1', 'admin@example.com', 'Admin', 'admin', 0, 0);
      INSERT INTO d1_databases (id, name, binding_name, kind, connection_secret, is_active, created_at)
        VALUES ('my1', 'tidb', 'my:my1', 'mysql', '${sealed}', 1, 0);
    `)
    return env
  }

  const post = async (env: Env, path: string, body: unknown) =>
    callWorker(env, path, postJson(body, { headers: await bearer(env, 'a1', 'admin') }))

  it('stops the batch after the running statement, which still completes', { timeout: 120_000 }, async () => {
    const env = await liveEnv()
    // How long one request needs before its statement starts (session open + the USE pin), so the
    // cancel below lands while the statement is running rather than before it
    const warmupAt = Date.now()
    expect((await post(env, '/api/query', { databaseId: 'my1', sql: 'select 1 as one' })).status).toBe(200)
    const openMs = Date.now() - warmupAt
    console.log(`[mysql-cancel-live] one request takes ${openMs} ms before its statement runs`)

    const executionId = crypto.randomUUID()
    const started = Date.now()
    const pending = post(env, '/api/query/batch', {
      databaseId: 'my1',
      statements: ['select sleep(4) as s', 'select 2 as b'],
      executionId,
    })
    await sleep(openMs + 1200)
    const cancelled = await post(env, '/api/query/cancel', { executionId })
    expect(cancelled.status).toBe(200)
    expect(await cancelled.json()).toEqual({ ok: true, cancelled: true })

    const res = await pending
    const elapsed = Date.now() - started
    console.log(`[mysql-cancel-live] batch answered after ${elapsed} ms for a 4 s statement`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      results: Array<{ sql?: string; results?: unknown[]; cancelled?: boolean }>
      cancelled: boolean
      halted: boolean
    }
    // The first statement reached the server and ran to completion (there is no kill here), the
    // second never started
    expect(body.results).toHaveLength(1)
    expect(body.results[0]!.results).toEqual([{ s: '0' }])
    expect(body.results[0]!.cancelled).toBeUndefined()
    expect(body.cancelled).toBe(true)
    expect(body.halted).toBe(false)
    // The statement was not aborted client-side: the batch waited for its full 4 s
    expect(elapsed).toBeGreaterThan(4000)
  })

  it('returns a completed single statement as it was, even though a cancel was requested', {
    timeout: 120_000,
  }, async () => {
    const env = await liveEnv()
    // Same warm-up as above: the cancel must arrive while the statement runs, not before it starts
    const warmupAt = Date.now()
    expect((await post(env, '/api/query', { databaseId: 'my1', sql: 'select 1 as one' })).status).toBe(200)
    const openMs = Date.now() - warmupAt

    const executionId = crypto.randomUUID()
    const started = Date.now()
    const pending = post(env, '/api/query', { databaseId: 'my1', sql: 'select sleep(4) as s', executionId })
    await sleep(openMs + 1200)
    expect(await (await post(env, '/api/query/cancel', { executionId })).json()).toEqual({
      ok: true,
      cancelled: true,
    })

    const res = await pending
    console.log(`[mysql-cancel-live] single statement answered after ${Date.now() - started} ms`)
    expect(res.status).toBe(200)
    // Nothing was stopped (TiDB has no kill channel), so the result is the statement's own
    expect(await res.json()).toMatchObject({ results: [{ s: '0' }], cancelled: false })
  })
})
