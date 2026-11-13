import { describe, expect, it } from 'vitest'
import { getMigrations } from '../migrations'
import { cancelPostgresExecution, openPostgresSession } from '../pg-executor'
import { normalizePostgresUrl } from '../pg-url'
import { sealSecret } from '../secrets'
import type { Env } from '../../types'
import { bearer, callWorker, fakeEnv, postJson } from '../../routes/__tests__/fakes'
import { sqliteD1 } from '../../routes/__tests__/sqlite-d1'

// Opt-in live test for cancellation against a real PostgreSQL server (the team's Neon instance; the
// connection string comes from the environment, never from the repo).
//
//   NEON_DIRECT_URL=… pnpm test -- pg-cancel-live
//
// The direct endpoint is preferred: the spike measured marker-based cancels landing 4/4 there, while a
// pooled endpoint may have no backend carrying the marker at that moment — the kill then misses *by
// design* (the flag still stops the batch at the next statement), so the strict timing assertion below
// would not be meaningful against it. Nothing outside the test's own statements is touched.
const LIVE_URL = process.env.NEON_DIRECT_URL ?? process.env.NEON_POOLER_URL ?? ''

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

// Waits until the statement really is running on the server before the cancel is sent. A cancel only
// addresses an *active* backend carrying the marker, so cancelling while the connection is still
// being established (a cold endpoint can take seconds) misses by design — which is a property worth
// having, but not something to measure a latency from.
async function waitUntilActive(url: string, marker: string, timeoutMs = 20_000): Promise<void> {
  const probe = await openPostgresSession(url, { applicationName: 'zeta-live-probe' })
  try {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const check = await probe.run(
        `select count(*) as n from pg_stat_activity where application_name = '${marker}' and state = 'active'`,
        'read',
        1
      )
      if (Number(check.results[0]?.n ?? 0) > 0) return
      await sleep(250)
    }
    throw new Error(`no active statement carried marker ${marker} within ${timeoutMs} ms`)
  } finally {
    await probe.close()
  }
}

// The app database is a real in-memory SQLite with the production schema, so the registry,
// permission and history statements all run for real; only the query target is remote.
async function liveEnv(): Promise<{ env: Env; sqlite: ReturnType<typeof sqliteD1>['sqlite'] }> {
  const app = sqliteD1()
  for (const migration of getMigrations({ TABLE_PREFIX: '' })) app.sqlite.exec(migration.sql)
  const env = fakeEnv({ DB: app.db })
  const sealed = await sealSecret(env, JSON.stringify({ url: LIVE_URL }))
  app.sqlite.exec(`
    INSERT INTO users (id, email, name, role, created_at, updated_at)
      VALUES ('a1', 'admin@example.com', 'Admin', 'admin', 0, 0);
    INSERT INTO d1_databases (id, name, binding_name, kind, connection_secret, is_active, created_at)
      VALUES ('pg1', 'neon', 'pg:pg1', 'postgres', '${sealed}', 1, 0);
  `)
  return { env, sqlite: app.sqlite }
}

describe.skipIf(!LIVE_URL)('postgres cancellation against a live server', () => {
  it('stops a running statement through POST /api/query/cancel', { timeout: 120_000 }, async () => {
    const { env, sqlite } = await liveEnv()
    const normalized = normalizePostgresUrl(LIVE_URL)
    expect(normalized.ok).toBe(true)
    if (!normalized.ok) return
    const headers = await bearer(env, 'a1', 'admin')
    const executionId = crypto.randomUUID()

    // A 20 s statement, cancelled once the connection is up: it may only end because of the kill
    const started = Date.now()
    const pending = callWorker(
      env,
      '/api/query',
      postJson({ databaseId: 'pg1', sql: 'select pg_sleep(20)', executionId }, { headers })
    )
    await waitUntilActive(normalized.url, executionId)
    const cancelled = await callWorker(env, '/api/query/cancel', postJson({ executionId }, { headers }))
    const cancelAnsweredAt = Date.now()
    expect(cancelled.status).toBe(200)
    expect(await cancelled.json()).toEqual({ ok: true, cancelled: true })

    const res = await pending
    const total = Date.now() - started
    const stopLatency = Date.now() - cancelAnsweredAt
    console.log(`[pg-cancel-live] statement ended ${stopLatency} ms after the cancel response, ${total} ms total`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { cancelled?: boolean; error?: string }
    // Cancelled, not an error: the driver's 57014 never reaches the client as a failure
    expect(body.cancelled).toBe(true)
    expect(body.error).toBeUndefined()
    // The 20 s sleep did not run to completion, and the kill took effect promptly
    expect(total).toBeLessThan(15_000)
    expect(stopLatency).toBeLessThan(3000)
    expect(sqlite.prepare('SELECT outcome FROM executions WHERE id = ?').all(executionId)[0]).toEqual({
      outcome: 'cancelled',
    })

    // The target is fine afterwards: the cancel ended a statement, not the connection pool
    const after = await callWorker(
      env,
      '/api/query',
      postJson({ databaseId: 'pg1', sql: 'select 1 as ok' }, { headers })
    )
    expect(after.status).toBe(200)
    expect(await after.json()).toMatchObject({ cancelled: false })
  })

  it('cancels by application_name marker and leaves that session usable', { timeout: 120_000 }, async () => {
    const normalized = normalizePostgresUrl(LIVE_URL)
    expect(normalized.ok).toBe(true)
    if (!normalized.ok) return

    const marker = `zeta-live-${crypto.randomUUID()}`
    const session = await openPostgresSession(normalized.url, { applicationName: marker })
    try {
      // Long enough that opening the cancel's own connection cannot outlast it
      const running = session.run('select pg_sleep(20)', 'read', 10).then(
        () => null,
        (err: Error) => err
      )
      await waitUntilActive(normalized.url, marker)
      const { killed } = await cancelPostgresExecution(normalized.url, marker)
      const outcome = await running
      console.log(`[pg-cancel-live] marker kill = ${String(killed)}`)
      // The original request's 57014 is the evidence; the return value is only corroboration
      expect(outcome).toBeInstanceOf(Error)
      expect(String(outcome?.message)).toMatch(/cancel/i)
      // Same connection, next statement: the kill ended a statement, not the session
      const after = await session.run("select 'still-alive' as ok", 'read', 1)
      expect(after.results).toEqual([{ ok: 'still-alive' }])
    } finally {
      await session.close()
    }
  })

  it('misses safely when no session carries the marker', { timeout: 90_000 }, async () => {
    const normalized = normalizePostgresUrl(LIVE_URL)
    expect(normalized.ok).toBe(true)
    if (!normalized.ok) return

    const marker = `zeta-live-${crypto.randomUUID()}`
    const session = await openPostgresSession(normalized.url, { applicationName: marker })
    try {
      const running = session.run('select pg_sleep(2)', 'read', 10)
      await sleep(500)
      // A marker nobody uses: the kill must not touch this session's statement
      expect(await cancelPostgresExecution(normalized.url, `zeta-live-${crypto.randomUUID()}`)).toEqual({
        killed: false,
      })
      const result = await running
      // The statement ran to completion (one row, its value shape is the driver's business)
      expect(result.results).toHaveLength(1)
    } finally {
      await session.close()
    }
  })
})
