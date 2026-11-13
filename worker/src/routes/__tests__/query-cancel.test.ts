import { afterEach, describe, expect, it, vi } from 'vitest'
import { getMigrations } from '../../lib/migrations'
import { sealSecret } from '../../lib/secrets'
import type { Env } from '../../types'
import { bearer, callWorker, fakeEnv, postJson } from './fakes'
import { sqliteD1 } from './sqlite-d1'

// Cancellation on the query routes: the registry row, POST /api/query/cancel and the engine-side
// kill. The executors are replaced by scripted sessions, so these tests check the wiring — which
// engine gets which address, when a kill is sent at all, and what a cancelled response looks like.

type Run = { sql: string; kind: string }

const pg = vi.hoisted(() => ({
  opened: [] as Array<{ url: string; opts: unknown; runs: Run[]; closed: boolean }>,
  queue: [] as Array<{ results?: unknown[]; changes?: number; error?: { message: string; kind: string } }>,
  cancels: [] as Array<{ url: string; marker: string }>,
  onOpen: null as null | (() => Promise<void>),
  onRun: null as null | (() => Promise<void>),
}))

vi.mock('../../lib/pg-executor', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/pg-executor')>()
  return {
    ...actual,
    openPostgresSession: async (url: string, opts?: unknown) => {
      const record = { url, opts, runs: [] as Run[], closed: false }
      pg.opened.push(record)
      if (pg.onOpen) await pg.onOpen()
      return {
        async run(sql: string, kind: string) {
          record.runs.push({ sql, kind })
          if (pg.onRun) await pg.onRun()
          const next = pg.queue.shift()
          if (next?.error) throw new actual.PostgresQueryError(next.error.message, next.error.kind as never)
          return { results: next?.results ?? [], meta: {}, changes: next?.changes, truncated: false }
        },
        async close() {
          record.closed = true
        },
      }
    },
    cancelPostgresExecution: async (url: string, marker: string) => {
      pg.cancels.push({ url, marker })
      return { killed: true }
    },
  }
})

const spark = vi.hoisted(() => ({
  opened: [] as Array<{ opts: unknown }>,
  queue: [] as Array<{ results?: unknown[]; error?: { message: string; kind: string; code: string } }>,
  cancels: [] as Array<{ session?: string; execution?: string }>,
  onRun: null as null | (() => Promise<void>),
}))

vi.mock('../../lib/spark-executor', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/spark-executor')>()
  return {
    ...actual,
    openSparkSession: async (_access: unknown, opts?: unknown) => {
      const record = { opts }
      spark.opened.push(record)
      return {
        sparkVersion: '3.5.3',
        async run(_sql: string, _kind: string) {
          if (spark.onRun) await spark.onRun()
          const next = spark.queue.shift()
          if (next?.error) {
            throw new actual.SparkQueryError(next.error.message, next.error.kind as never, next.error.code as never)
          }
          return { results: next?.results ?? [], meta: {}, truncated: false }
        },
        async close() {},
      }
    },
    cancelSparkExecution: async (_access: unknown, opts: { session?: string; execution?: string }) => {
      spark.cancels.push(opts)
      return { ok: true }
    },
  }
})

const APP_DB = '99999999-9999-4999-8999-999999999999'
const D1_DB = '88888888-8888-4888-8888-888888888888'
const EXEC = '11111111-1111-4111-8111-111111111111'
const OTHER = '22222222-2222-4222-8222-222222222222'
const STORED_URL = 'postgres://owner:pw@ep-x-pooler.example.neon.tech/neondb?sslmode=require'

afterEach(() => {
  vi.unstubAllGlobals()
  pg.opened.length = 0
  pg.queue.length = 0
  pg.cancels.length = 0
  pg.onOpen = null
  pg.onRun = null
  spark.opened.length = 0
  spark.queue.length = 0
  spark.cancels.length = 0
  spark.onRun = null
})

// A real in-memory app database (registry, executions, permissions) with one PostgreSQL and one
// Spark target registered.
async function cancelEnv(): Promise<{ env: Env; sqlite: ReturnType<typeof sqliteD1>['sqlite'] }> {
  const app = sqliteD1()
  for (const migration of getMigrations({ TABLE_PREFIX: '' })) app.sqlite.exec(migration.sql)
  const env = fakeEnv({ DB: app.db })
  const pgSecret = await sealSecret(env, JSON.stringify({ url: STORED_URL }))
  const sparkSecret = await sealSecret(
    env,
    JSON.stringify({ url: 'https://spark-1.publish.example.dev', platform_token: 'pt', app_token: 'at' })
  )
  app.sqlite.exec(`
    INSERT INTO users (id, email, name, role, created_at, updated_at)
      VALUES ('u1', 'one@example.com', 'One', 'member', 0, 0),
             ('u2', 'two@example.com', 'Two', 'member', 0, 0),
             ('a1', 'admin@example.com', 'Admin', 'admin', 0, 0);
    INSERT INTO d1_databases (id, name, binding_name, kind, connection_secret, is_active, created_at) VALUES
      ('pg1', 'neon', 'pg:pg1', 'postgres', '${pgSecret}', 1, 0),
      ('sp1', 'spark', 'spark:sp1', 'spark', '${sparkSecret}', 1, 0);
    INSERT INTO user_database_permissions (id, user_id, database_id, permission, granted_at) VALUES
      ('p1', 'u1', 'pg1', 'read', 0),
      ('p2', 'u1', 'sp1', 'read', 0),
      ('p3', 'u2', 'pg1', 'read', 0);
  `)
  return { env, sqlite: app.sqlite }
}

const cancel = async (env: Env, executionId: string, userId = 'u1', role: 'admin' | 'member' = 'member') =>
  callWorker(env, '/api/query/cancel', postJson({ executionId }, { headers: await bearer(env, userId, role) }))

const registry = (sqlite: ReturnType<typeof sqliteD1>['sqlite'], id = EXEC) =>
  sqlite.prepare('SELECT * FROM executions WHERE id = ?').all(id)[0] as Record<string, unknown> | undefined

describe('execution registration', () => {
  it('registers a PostgreSQL request under its execution id and marks the connection', async () => {
    const { env, sqlite } = await cancelEnv()
    pg.queue.push({ results: [{ n: 1 }] })

    const res = await callWorker(
      env,
      '/api/query',
      postJson({ databaseId: 'pg1', sql: 'SELECT 1', executionId: EXEC }, { headers: await bearer(env, 'u1') })
    )

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ results: [{ n: 1 }], cancelled: false })
    // The marker a cancel addresses is the execution id, written where the executors read it
    expect((pg.opened[0]!.opts as { applicationName?: string }).applicationName).toBe(EXEC)
    expect(registry(sqlite)).toMatchObject({
      user_id: 'u1',
      database_id: 'pg1',
      kind: 'postgres',
      handle: EXEC,
      outcome: 'ok',
    })
  })

  it('leaves the registry untouched and marks nothing when the body carries no id', async () => {
    const { env, sqlite } = await cancelEnv()
    pg.queue.push({ results: [{ n: 1 }] })

    const res = await callWorker(
      env,
      '/api/query',
      postJson({ databaseId: 'pg1', sql: 'SELECT 1' }, { headers: await bearer(env, 'u1') })
    )

    expect(await res.json()).toMatchObject({ cancelled: false })
    expect((pg.opened[0]!.opts as { applicationName?: string }).applicationName).toBeUndefined()
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM executions').all()[0]).toEqual({ n: 0 })
  })

  it('rejects a malformed executionId before anything opens', async () => {
    const { env } = await cancelEnv()
    for (const path of ['/api/query', '/api/query/batch']) {
      const body =
        path === '/api/query'
          ? { databaseId: 'pg1', sql: 'SELECT 1', executionId: 'nope' }
          : { databaseId: 'pg1', statements: ['SELECT 1'], executionId: 'nope' }
      const res = await callWorker(env, path, postJson(body, { headers: await bearer(env, 'u1') }))
      expect(res.status, path).toBe(400)
      expect(await res.json()).toEqual({ error: 'executionId must be a uuid' })
    }
    expect(pg.opened).toHaveLength(0)
  })

  it('refuses a second request under an id that is still running', async () => {
    const { env } = await cancelEnv()
    // The first request is still in flight when the second arrives
    pg.onRun = async () => {
      const second = await callWorker(
        env,
        '/api/query',
        postJson({ databaseId: 'pg1', sql: 'SELECT 2', executionId: EXEC }, { headers: await bearer(env, 'u1') })
      )
      expect(second.status).toBe(409)
      expect(await second.json()).toEqual({ error: 'executionId is already in use' })
    }
    pg.queue.push({ results: [{ n: 1 }] })

    const res = await callWorker(
      env,
      '/api/query',
      postJson({ databaseId: 'pg1', sql: 'SELECT 1', executionId: EXEC }, { headers: await bearer(env, 'u1') })
    )
    expect(res.status).toBe(200)
  })
})

describe('cancelling a PostgreSQL execution', () => {
  it('reports a statement stopped by the kill as cancelled, not as an error', async () => {
    const { env, sqlite } = await cancelEnv()
    // The killed statement rejects with 57014, exactly as the driver reports it
    pg.queue.push({ error: { message: 'canceling statement due to user request', kind: 'sql' } })
    pg.onRun = async () => {
      const res = await cancel(env, EXEC)
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ ok: true, cancelled: true })
    }

    const res = await callWorker(
      env,
      '/api/query',
      postJson(
        { databaseId: 'pg1', sql: 'SELECT pg_sleep(10)', executionId: EXEC },
        { headers: await bearer(env, 'u1') }
      )
    )

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ cancelled: true, results: [] })
    // The kill carried the row's marker, on the registered connection string
    expect(pg.cancels).toEqual([{ url: STORED_URL, marker: EXEC }])
    expect(registry(sqlite)).toMatchObject({ outcome: 'cancelled' })
  })

  it('never starts the statement when the cancel wins the race with opening', async () => {
    const { env } = await cancelEnv()
    pg.onOpen = async () => {
      await cancel(env, EXEC)
    }
    pg.queue.push({ results: [{ n: 1 }] })

    const res = await callWorker(
      env,
      '/api/query',
      postJson({ databaseId: 'pg1', sql: 'SELECT 1', executionId: EXEC }, { headers: await bearer(env, 'u1') })
    )

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ cancelled: true, results: [] })
    expect(pg.opened[0]!.runs).toEqual([])
  })

  it('stops a batch at the statement boundary and says so', async () => {
    const { env } = await cancelEnv()
    pg.onRun = async () => {
      await cancel(env, EXEC)
    }
    pg.queue.push({ results: [{ n: 1 }] }, { results: [{ n: 2 }] })

    const res = await callWorker(
      env,
      '/api/query/batch',
      postJson(
        { databaseId: 'pg1', statements: ['SELECT 1', 'SELECT 2'], executionId: EXEC },
        { headers: await bearer(env, 'u1') }
      )
    )

    expect(res.status).toBe(200)
    const body = (await res.json()) as { results: unknown[]; halted: boolean; cancelled: boolean }
    expect(body.results).toHaveLength(1)
    expect(body.cancelled).toBe(true)
    // A cancellation is not a failure: halted stays false
    expect(body.halted).toBe(false)
    expect(pg.opened[0]!.runs.map((r) => r.sql)).toEqual(['SELECT 1'])
  })

  it('marks the interrupted statement cancelled inside the batch, without an error', async () => {
    const { env } = await cancelEnv()
    pg.onRun = async () => {
      await cancel(env, EXEC)
    }
    pg.queue.push({ error: { message: 'canceling statement due to user request', kind: 'sql' } })

    const res = await callWorker(
      env,
      '/api/query/batch',
      postJson(
        { databaseId: 'pg1', statements: ['SELECT pg_sleep(10)', 'SELECT 2'], executionId: EXEC },
        { headers: await bearer(env, 'u1') }
      )
    )

    const body = (await res.json()) as {
      results: Array<{ cancelled?: boolean; error?: string }>
      halted: boolean
      cancelled: boolean
    }
    expect(body.results).toHaveLength(1)
    expect(body.results[0]).toMatchObject({ cancelled: true })
    expect(body.results[0]!.error).toBeUndefined()
    expect(body.cancelled).toBe(true)
    expect(body.halted).toBe(false)
  })
})

describe('cancelling a Spark execution', () => {
  it('addresses the job group by session and execution id, and reports the killed job as cancelled', async () => {
    const { env } = await cancelEnv()
    // The service answers a killed statement with its ordinary 200 + error stack (spike #27 §10.2)
    spark.queue.push({
      error: { message: 'Job 45 cancelled part of cancelled job group', kind: 'sql', code: 'spark_sql' },
    })
    spark.onRun = async () => {
      const res = await cancel(env, EXEC)
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ ok: true, cancelled: true })
    }

    const res = await callWorker(
      env,
      '/api/query',
      postJson(
        { databaseId: 'sp1', sql: 'select count(*) from range(3000000000)', executionId: EXEC },
        { headers: await bearer(env, 'u1') }
      )
    )

    expect(res.status).toBe(200)
    const body = (await res.json()) as { cancelled?: boolean; error?: string; code?: string }
    expect(body.cancelled).toBe(true)
    // The stack is not passed on as an error, and no error code rides along
    expect(body.error).toBeUndefined()
    expect(body.code).toBeUndefined()
    expect(spark.cancels).toEqual([{ session: 'u1', execution: EXEC }])
    expect((spark.opened[0]!.opts as { execution?: string }).execution).toBe(EXEC)
  })

  it('sends one kill for a repeated cancel, and none for an execution that already finished', async () => {
    const { env } = await cancelEnv()
    spark.onRun = async () => {
      await cancel(env, EXEC)
      // A second cancel answers the same way but must not send a second kill
      expect(await (await cancel(env, EXEC)).json()).toEqual({ ok: true, cancelled: true })
    }
    spark.queue.push({ results: [] })

    await callWorker(
      env,
      '/api/query',
      postJson({ databaseId: 'sp1', sql: 'select 1', executionId: EXEC }, { headers: await bearer(env, 'u1') })
    )
    expect(spark.cancels).toHaveLength(1)

    // The execution has finished: nothing to cancel, nothing to kill
    const late = await cancel(env, EXEC)
    expect(late.status).toBe(200)
    expect(await late.json()).toEqual({ ok: true, cancelled: false })
    expect(spark.cancels).toHaveLength(1)
  })
})

describe('POST /api/query/cancel permissions and contract', () => {
  it("answers 404 for another user's execution and for an unknown id, identically — admins included", async () => {
    const { env } = await cancelEnv()
    pg.onRun = async () => {
      const foreign = await cancel(env, EXEC, 'u2')
      expect(foreign.status).toBe(404)
      expect(await foreign.json()).toEqual({ error: 'Execution not found' })
      // Cancelling belongs to the initiator alone: an admin has no override, and the answer is the
      // same one a stranger gets (no enumeration of other people's executions)
      const asAdmin = await cancel(env, EXEC, 'a1', 'admin')
      expect(asAdmin.status).toBe(404)
      expect(await asAdmin.json()).toEqual({ error: 'Execution not found' })
      const anon = await cancel(env, OTHER)
      expect(anon.status).toBe(404)
      expect(await anon.json()).toEqual({ error: 'Execution not found' })
    }
    pg.queue.push({ results: [] })

    const res = await callWorker(
      env,
      '/api/query',
      postJson({ databaseId: 'pg1', sql: 'SELECT 1', executionId: EXEC }, { headers: await bearer(env, 'u1') })
    )
    expect(res.status).toBe(200)
    // Neither the stranger's nor the admin's attempt set a flag or sent a kill
    expect(await res.json()).toMatchObject({ cancelled: false })
    expect(pg.cancels).toEqual([])
  })

  it('rejects a missing or malformed executionId', async () => {
    const { env } = await cancelEnv()
    for (const body of [{}, { executionId: 'nope' }, { executionId: 42 }]) {
      const res = await callWorker(env, '/api/query/cancel', postJson(body, { headers: await bearer(env, 'u1') }))
      expect(res.status, JSON.stringify(body)).toBe(400)
      expect(await res.json()).toEqual({ error: 'executionId is required' })
    }
  })

  it('requires a signed-in caller', async () => {
    const { env } = await cancelEnv()
    const res = await callWorker(env, '/api/query/cancel', postJson({ executionId: EXEC }))
    expect(res.status).toBe(401)
  })
})

// ── The engines with no kill channel ─────────────────────────────────────────
// D1 goes through Cloudflare's HTTP API and TiDB through its own HTTPS endpoint: neither exposes a
// handle a cancel could address, so a cancellation only sets the flag and stops the request at the
// next statement boundary. The running statement cannot be stopped — and must not be reported as if
// it were.

const d1Response = (results: unknown[]) =>
  new Response(JSON.stringify({ success: true, result: [{ success: true, results, meta: { changes: 0 } }] }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })

async function d1Env(): Promise<{ env: Env; sqlite: ReturnType<typeof sqliteD1>['sqlite'] }> {
  const app = sqliteD1()
  for (const migration of getMigrations({ TABLE_PREFIX: '' })) app.sqlite.exec(migration.sql)
  const env = fakeEnv({ DB: app.db, CF_ACCOUNT_ID: 'acct', CLOUDFLARE_API_TOKEN: 'tok', ZETA_APP_DB_ID: APP_DB })
  app.sqlite.exec(`
    INSERT INTO users (id, email, name, role, created_at, updated_at)
      VALUES ('u1', 'one@example.com', 'One', 'member', 0, 0);
    INSERT INTO d1_databases (id, name, binding_name, cf_database_id, is_active, created_at)
      VALUES ('d1a', 'cf-db', 'cf:d1a', '${D1_DB}', 1, 0);
    INSERT INTO user_database_permissions (id, user_id, database_id, permission, granted_at)
      VALUES ('p1', 'u1', 'd1a', 'read', 0);
    INSERT INTO notebooks (id, user_id, name, sql_content, database_id, created_at, updated_at)
      VALUES ('nb1', 'u1', 'One', '', 'd1a', 0, 0);
  `)
  return { env, sqlite: app.sqlite }
}

describe('cancelling a D1 execution (no kill channel)', () => {
  it("returns the running statement's result and stops the batch at the next boundary", async () => {
    const { env, sqlite } = await d1Env()
    let calls = 0
    // The cancel arrives while the first statement is already on its way to Cloudflare
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls++
        if (calls === 1) {
          const res = await cancel(env, EXEC)
          expect(await res.json()).toEqual({ ok: true, cancelled: true })
        }
        return d1Response([{ n: calls }])
      })
    )

    const res = await callWorker(
      env,
      '/api/query/batch',
      postJson(
        { databaseId: 'd1a', statements: ['SELECT 1', 'SELECT 2'], executionId: EXEC, notebookId: 'nb1' },
        { headers: await bearer(env, 'u1') }
      )
    )

    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      results: Array<{ results?: unknown[]; cancelled?: boolean }>
      cancelled: boolean
      halted: boolean
      run_id: string
      seq: number
    }
    // Only Cloudflare saw a statement; the second one never ran
    expect(calls).toBe(1)
    expect(body.results).toHaveLength(1)
    // That statement had already completed, so its rows are real and it is not marked cancelled
    expect(body.results[0]).toMatchObject({ results: [{ n: 1 }] })
    expect(body.results[0]!.cancelled).toBeUndefined()
    expect(body.cancelled).toBe(true)
    expect(body.halted).toBe(false)

    // A cancellation is stored with the run, next to halted, and reads back the same way
    expect(sqlite.prepare('SELECT halted, cancelled, statement_count FROM notebook_runs').all()[0]).toEqual({
      halted: 0,
      cancelled: 1,
      statement_count: 2,
    })
    const detail = await callWorker(env, `/api/notebooks/nb1/runs/${body.run_id}`, {
      headers: await bearer(env, 'u1'),
    })
    expect(await detail.json()).toMatchObject({ cancelled: true, halted: false, statement_count: 2 })
    const list = await callWorker(env, '/api/notebooks/nb1/runs', { headers: await bearer(env, 'u1') })
    expect(((await list.json()) as { results: Array<{ cancelled: boolean }> }).results.map((r) => r.cancelled)).toEqual(
      [true]
    )
  })

  it('reports a single completed statement as it was, even though a cancel was requested', async () => {
    const { env, sqlite } = await d1Env()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        await cancel(env, EXEC)
        return d1Response([{ n: 1 }])
      })
    )

    const res = await callWorker(
      env,
      '/api/query',
      postJson({ databaseId: 'd1a', sql: 'SELECT 1', executionId: EXEC }, { headers: await bearer(env, 'u1') })
    )

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ results: [{ n: 1 }], cancelled: false })
    // The execution still closed as a success: nothing was stopped
    expect(sqlite.prepare('SELECT outcome FROM executions WHERE id = ?').all(EXEC)[0]).toEqual({ outcome: 'ok' })
  })
})
