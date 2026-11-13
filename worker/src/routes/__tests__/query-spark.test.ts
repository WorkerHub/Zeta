import { afterEach, describe, expect, it, vi } from 'vitest'
import { getMigrations } from '../../lib/migrations'
import { sealSecret } from '../../lib/secrets'
import type { Permission } from '../../lib/sql-guard'
import type { Env } from '../../types'
import { bearer, callWorker, fakeEnv, postJson } from './fakes'
import { sqliteD1 } from './sqlite-d1'

// SparkSQL targets on the query routes. The executor is replaced by a scripted session, so these
// tests check the wiring: the spark dialect, the payload round trip, the four failure messages with
// their codes, and the probe endpoint's contract (no history row, no run number, no D1 request).

type Run = { sql: string; kind: string }

const spark = vi.hoisted(() => ({
  opened: [] as Array<{ url: string; runs: Run[]; closed: boolean; opts: unknown }>,
  queue: [] as Array<{
    results?: unknown[]
    truncated?: boolean
    error?: { message: string; kind: string; code: string }
  }>,
  openError: null as null | { message: string; kind: string; code: string },
}))

vi.mock('../../lib/spark-executor', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/spark-executor')>()
  return {
    ...actual,
    openSparkSession: async (access: { url: string }, opts?: unknown) => {
      if (spark.openError) {
        const pending = spark.openError
        spark.openError = null
        throw new actual.SparkQueryError(pending.message, pending.kind as never, pending.code as never)
      }
      const record = { url: access.url, runs: [] as Run[], closed: false, opts }
      spark.opened.push(record)
      return {
        sparkVersion: '3.5.3',
        async run(sql: string, kind: string) {
          record.runs.push({ sql, kind })
          const next = spark.queue.shift()
          if (next?.error) {
            throw new actual.SparkQueryError(next.error.message, next.error.kind as never, next.error.code as never)
          }
          return { results: next?.results ?? [], meta: {}, truncated: next?.truncated ?? false }
        },
        async close() {
          record.closed = true
        },
      }
    },
  }
})

const { CONNECT_TEST_OPEN, SPARK_APP_TOKEN_MESSAGE, SPARK_STARTING_MESSAGE, SPARK_STOPPED_MESSAGE, VERIFY_HEALTH } =
  await import('../../lib/spark-executor')

const HOST = 'spark-3f9a.publish.example.dev'
const PAYLOAD = {
  url: `https://${HOST}`,
  platform_token: 'platform-token-abc123',
  app_token: 'app-token-xyz789',
}

afterEach(() => {
  spark.opened.length = 0
  spark.queue.length = 0
  spark.openError = null
})

// The app database is a real in-memory SQLite with the production schema, so the registry,
// permission, history and run statements all run for real.
async function sparkEnv(
  storedPermission: Permission = 'read'
): Promise<{ env: Env; app: ReturnType<typeof sqliteD1> }> {
  const app = sqliteD1()
  for (const migration of getMigrations({ TABLE_PREFIX: '' })) app.sqlite.exec(migration.sql)
  const env = fakeEnv({ DB: app.db })
  const sealed = await sealSecret(env, JSON.stringify(PAYLOAD))
  app.sqlite.exec(`
    INSERT INTO users (id, email, name, role, created_at, updated_at)
      VALUES ('u1', 'member@example.com', 'Member', 'member', 0, 0),
             ('a1', 'admin@example.com', 'Admin', 'admin', 0, 0);
    INSERT INTO d1_databases (id, name, binding_name, kind, connection_secret, is_active, created_at)
      VALUES ('sp1', 'spark', 'spark:sp1', 'spark', '${sealed}', 1, 0),
             ('d1', 'local', 'cf:d1', 'sqlite', NULL, 1, 0);
    INSERT INTO user_database_permissions (id, user_id, database_id, permission, granted_at)
      VALUES ('p1', 'u1', 'sp1', '${storedPermission}', 0);
  `)
  return { env, app }
}

const post = (env: Env, path: string, body: unknown, headers: Record<string, string>) =>
  callWorker(env, path, postJson(body, { headers }))

const countRows = (app: ReturnType<typeof sqliteD1>, table: string): number => {
  const rows = app.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).all() as Array<{ n: number }>
  return Number(rows[0]!.n)
}

describe('query a SparkSQL target', () => {
  it('decrypts the payload, re-normalises it, runs the read and closes the session', async () => {
    const { env } = await sparkEnv('read')
    spark.queue.push({ results: [{ n: 1 }] })
    const res = await post(env, '/api/query', { databaseId: 'sp1', sql: 'SELECT 1 AS n' }, await bearer(env, 'u1'))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ results: [{ n: 1 }], truncated: false })
    expect(spark.opened).toHaveLength(1)
    // The stored payload is normalised again before the executor sees it
    expect(spark.opened[0]!.url).toBe(PAYLOAD.url)
    expect(spark.opened[0]!.runs).toEqual([{ sql: 'SELECT 1 AS n', kind: 'read' }])
    expect(spark.opened[0]!.closed).toBe(true)
    // A query gets the short budget, never the connection check's
    expect(spark.opened[0]!.opts).toBeUndefined()
  })

  it('refuses the spark-forbidden statements before opening a session', async () => {
    const { env } = await sparkEnv()
    for (const sql of [
      'SET spark.sql.shuffle.partitions=2',
      'USE other',
      'CACHE TABLE t',
      'ADD JAR /tmp/x.jar',
      "CREATE FUNCTION f AS 'com.evil.Payload'",
      "SELECT TRANSFORM(a) USING 'bash -c id' FROM t",
      'SELECT * FROM parquet.`/data/x`',
    ]) {
      const res = await post(env, '/api/query', { databaseId: 'sp1', sql }, await bearer(env, 'a1', 'admin'))
      expect(res.status, sql).toBe(403)
    }
    expect(spark.opened).toHaveLength(0)
  })

  it('shows a stopped machine to members, with the sentence and the code', async () => {
    const { env } = await sparkEnv()
    spark.openError = { message: SPARK_STOPPED_MESSAGE, kind: 'stopped', code: 'spark_stopped' }
    const res = await post(env, '/api/query', { databaseId: 'sp1', sql: 'SELECT 1' }, await bearer(env, 'u1'))
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: SPARK_STOPPED_MESSAGE, code: 'spark_stopped' })
  })

  it('shows a booting machine to members as "try again shortly", with its own code', async () => {
    const { env } = await sparkEnv()
    spark.openError = { message: SPARK_STARTING_MESSAGE, kind: 'starting', code: 'spark_not_ready' }
    const res = await post(env, '/api/query', { databaseId: 'sp1', sql: 'SELECT 1' }, await bearer(env, 'u1'))
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: SPARK_STARTING_MESSAGE, code: 'spark_not_ready' })
  })

  it('keeps a rejected token to admins, and sends no code to a member', async () => {
    const { env } = await sparkEnv()
    spark.queue.push({ error: { message: SPARK_APP_TOKEN_MESSAGE, kind: 'auth', code: 'spark_app_token' } })

    const member = await post(env, '/api/query', { databaseId: 'sp1', sql: 'SELECT 1' }, await bearer(env, 'u1'))
    expect(member.status).toBe(500)
    expect(await member.json()).toEqual({ error: 'Database configuration error. Contact the admin.' })

    spark.queue.push({ error: { message: SPARK_APP_TOKEN_MESSAGE, kind: 'auth', code: 'spark_app_token' } })
    const admin = await post(
      env,
      '/api/query',
      { databaseId: 'sp1', sql: 'SELECT 1' },
      await bearer(env, 'a1', 'admin')
    )
    expect(admin.status).toBe(500)
    expect(await admin.json()).toEqual({ error: SPARK_APP_TOKEN_MESSAGE, code: 'spark_app_token' })
  })

  it('shows a rejected statement to everyone as a 400 with the sql code', async () => {
    const { env } = await sparkEnv()
    spark.queue.push({
      error: {
        message: '[TABLE_OR_VIEW_NOT_FOUND] The table or view `zeta.nope` cannot be found.',
        kind: 'sql',
        code: 'spark_sql',
      },
    })
    const res = await post(env, '/api/query', { databaseId: 'sp1', sql: 'SELECT * FROM nope' }, await bearer(env, 'u1'))
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ code: 'spark_sql' })
  })

  it('leaves a batch statement error as plain text, with no code', async () => {
    const { env } = await sparkEnv()
    spark.queue.push({ results: [{ n: 1 }] }, { error: { message: 'boom', kind: 'sql', code: 'spark_sql' } })
    const res = await post(
      env,
      '/api/query/batch',
      { databaseId: 'sp1', statements: ['SELECT 1', 'SELECT * FROM nope'] },
      await bearer(env, 'a1', 'admin')
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { results: Array<{ error?: string; code?: string }> }
    expect(body.results[0]!.error).toBeUndefined()
    expect(body.results[1]!.error).toBe('boom')
    expect(body.results[1]!.code).toBeUndefined()
    expect(spark.opened).toHaveLength(1)
  })

  it('refuses a spark row whose stored payload is missing', async () => {
    const { env } = await sparkEnv()
    await env.DB.prepare(`UPDATE d1_databases SET connection_secret = NULL WHERE id = 'sp1'`).run()
    const res = await post(env, '/api/query', { databaseId: 'sp1', sql: 'SELECT 1' }, await bearer(env, 'a1', 'admin'))
    expect(res.status).toBe(500)
    expect(((await res.json()) as { error: string }).error).toContain('no stored connection')
    expect(spark.opened).toHaveLength(0)
  })
})

describe('POST /api/query/probe', () => {
  it('reports a reachable spark target with the connection-check budget', async () => {
    const { env } = await sparkEnv()
    spark.queue.push({ results: [{ '1': 1 }] })
    const res = await post(env, '/api/query/probe', { databaseId: 'sp1' }, await bearer(env, 'u1'))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; kind: string; latency_ms: number }
    expect(body).toMatchObject({ ok: true, kind: 'spark' })
    expect(typeof body.latency_ms).toBe('number')
    // The probe opens with the patient budget: 20 s health, 120 s hard cap
    expect(spark.opened[0]!.opts).toBe(CONNECT_TEST_OPEN)
    expect(spark.opened[0]!.opts).toStrictEqual({ health: VERIFY_HEALTH, hardCapMs: 120_000 })
    expect(spark.opened[0]!.runs).toEqual([{ sql: 'select 1', kind: 'read' }])
    expect(spark.opened[0]!.closed).toBe(true)
  })

  it('answers a D1 target without probing anything', async () => {
    const { env, app } = await sparkEnv()
    const res = await post(env, '/api/query/probe', { databaseId: 'd1' }, await bearer(env, 'a1', 'admin'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, kind: 'sqlite', latency_ms: 0 })
    expect(spark.opened).toHaveLength(0)
    expect(countRows(app, 'query_history')).toBe(0)
  })

  it('reports a stopped machine with its code, and writes nothing', async () => {
    const { env, app } = await sparkEnv()
    spark.openError = { message: SPARK_STOPPED_MESSAGE, kind: 'stopped', code: 'spark_stopped' }
    const res = await post(env, '/api/query/probe', { databaseId: 'sp1' }, await bearer(env, 'u1'))
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: SPARK_STOPPED_MESSAGE, code: 'spark_stopped' })
    expect(countRows(app, 'query_history')).toBe(0)
    expect(countRows(app, 'notebook_runs')).toBe(0)
  })

  it('records neither history nor a run for a successful probe', async () => {
    const { env, app } = await sparkEnv()
    spark.queue.push({ results: [{ '1': 1 }] })
    const res = await post(env, '/api/query/probe', { databaseId: 'sp1' }, await bearer(env, 'u1'))
    expect(res.status).toBe(200)
    expect(countRows(app, 'query_history')).toBe(0)
    expect(countRows(app, 'notebook_runs')).toBe(0)
  })

  it('refuses a member without a permission row, and an unknown target', async () => {
    const { env } = await sparkEnv()
    await env.DB.prepare(`DELETE FROM user_database_permissions WHERE database_id = 'sp1'`).run()
    const denied = await post(env, '/api/query/probe', { databaseId: 'sp1' }, await bearer(env, 'u1'))
    expect(denied.status).toBe(403)

    const missing = await post(env, '/api/query/probe', { databaseId: 'nope' }, await bearer(env, 'a1', 'admin'))
    expect(missing.status).toBe(404)
    expect(spark.opened).toHaveLength(0)
  })

  it('requires a databaseId', async () => {
    const { env } = await sparkEnv()
    const res = await post(env, '/api/query/probe', {}, await bearer(env, 'a1', 'admin'))
    expect(res.status).toBe(400)
  })
})
