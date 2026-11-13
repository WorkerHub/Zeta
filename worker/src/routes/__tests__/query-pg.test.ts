import { afterEach, describe, expect, it, vi } from 'vitest'
import { getMigrations } from '../../lib/migrations'
import { sealSecret } from '../../lib/secrets'
import type { Permission } from '../../lib/sql-guard'
import type { Env } from '../../types'
import { bearer, callWorker, fakeEnv, postJson } from './fakes'
import { sqliteD1 } from './sqlite-d1'

// PostgreSQL targets on the query routes. The executor itself is replaced by a scripted session, so
// these tests check the wiring: dialect, translation, permission checks, the `Executed` mapping,
// and one connection per request (shared by a batch, closed afterwards).

type Run = { sql: string; kind: string }

const pg = vi.hoisted(() => ({
  opened: [] as Array<{ url: string; runs: Run[]; closed: boolean }>,
  queue: [] as Array<{
    results?: unknown[]
    changes?: number
    truncated?: boolean
    error?: { message: string; kind: string }
  }>,
  openError: null as null | { message: string; kind: string },
}))

vi.mock('../../lib/pg-executor', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/pg-executor')>()
  return {
    ...actual,
    openPostgresSession: async (url: string) => {
      if (pg.openError) {
        const pending = pg.openError
        pg.openError = null
        throw new actual.PostgresQueryError(pending.message, pending.kind as never)
      }
      const record = { url, runs: [] as Run[], closed: false }
      pg.opened.push(record)
      return {
        async run(sql: string, kind: string) {
          record.runs.push({ sql, kind })
          const next = pg.queue.shift()
          if (next?.error) throw new actual.PostgresQueryError(next.error.message, next.error.kind as never)
          return {
            results: next?.results ?? [],
            meta: next?.changes === undefined ? {} : { changes: next.changes },
            changes: next?.changes,
            truncated: next?.truncated ?? false,
          }
        },
        async close() {
          record.closed = true
        },
      }
    },
  }
})

const PASS = 'pw0rd'
const PG_URL = `postgres://owner:${PASS}@ep-x-pooler.example.neon.tech/neondb`
const STORED_URL = `${PG_URL}?sslmode=require`

afterEach(() => {
  pg.opened.length = 0
  pg.queue.length = 0
  pg.openError = null
})

// The app database is a real in-memory SQLite with the production schema, so the registry,
// permission and history statements all run for real.
async function pgEnv(storedPermission: Permission = 'read'): Promise<Env> {
  const app = sqliteD1()
  for (const migration of getMigrations({ TABLE_PREFIX: '' })) app.sqlite.exec(migration.sql)
  const env = fakeEnv({ DB: app.db })
  const sealed = await sealSecret(env, JSON.stringify({ url: STORED_URL }))
  app.sqlite.exec(`
    INSERT INTO users (id, email, name, role, created_at, updated_at)
      VALUES ('u1', 'member@example.com', 'Member', 'member', 0, 0),
             ('a1', 'admin@example.com', 'Admin', 'admin', 0, 0);
    INSERT INTO d1_databases (id, name, binding_name, kind, connection_secret, is_active, created_at)
      VALUES ('pg1', 'neon', 'pg:pg1', 'postgres', '${sealed}', 1, 0);
    INSERT INTO user_database_permissions (id, user_id, database_id, permission, granted_at)
      VALUES ('p1', 'u1', 'pg1', '${storedPermission}', 0);
  `)
  return env
}

const post = (env: Env, path: string, body: unknown, headers: Record<string, string>) =>
  callWorker(env, path, postJson(body, { headers }))

describe('query a PostgreSQL target', () => {
  it('decrypts the stored connection, hands the read to the session and closes it', async () => {
    const env = await pgEnv('read')
    pg.queue.push({ results: [{ n: '1' }] })
    const res = await post(env, '/api/query', { databaseId: 'pg1', sql: 'SELECT * FROM t' }, await bearer(env, 'u1'))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ results: [{ n: '1' }], truncated: false })
    expect(pg.opened).toHaveLength(1)
    expect(pg.opened[0]!.url).toBe(STORED_URL)
    // The row cap (limitReadSql with the PostgreSQL wrapper) is applied inside the session, so the
    // route hands the statement over untouched and the session's truncated flag is passed through.
    expect(pg.opened[0]!.runs).toEqual([{ sql: 'SELECT * FROM t', kind: 'read' }])
    expect(pg.opened[0]!.closed).toBe(true)
  })

  it('returns the affected row count for a write and no result rows', async () => {
    const env = await pgEnv()
    pg.queue.push({ changes: 3 })
    const res = await post(
      env,
      '/api/query',
      { databaseId: 'pg1', sql: 'DELETE FROM t' },
      await bearer(env, 'a1', 'admin')
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ results: [], meta: { changes: 3 } })
    expect(pg.opened[0]!.runs).toEqual([{ sql: 'DELETE FROM t', kind: 'write' }])
  })

  it('reuses one connection for a batch, in statement order, and closes it once', async () => {
    const env = await pgEnv()
    pg.queue.push({ results: [{ n: 1 }] }, { results: [{ n: 2 }] }, { results: [{ n: 3 }] })
    const res = await post(
      env,
      '/api/query/batch',
      { databaseId: 'pg1', statements: ['SELECT 1', 'SELECT 2', 'SELECT 3'] },
      await bearer(env, 'a1', 'admin')
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { results: Array<{ results: unknown[] }>; halted?: boolean }
    expect(body.results.map((r) => r.results)).toEqual([[{ n: 1 }], [{ n: 2 }], [{ n: 3 }]])
    expect(body.halted).toBe(false)
    expect(pg.opened).toHaveLength(1)
    expect(pg.opened[0]!.runs).toHaveLength(3)
    expect(pg.opened[0]!.closed).toBe(true)
  })

  it('stops the batch at the failing statement, keeping its error', async () => {
    const env = await pgEnv()
    pg.queue.push(
      { results: [{ n: 1 }] },
      { error: { message: 'relation "t" does not exist', kind: 'sql' } },
      { results: [{ n: 3 }] }
    )
    const res = await post(
      env,
      '/api/query/batch',
      { databaseId: 'pg1', statements: ['SELECT 1', 'SELECT * FROM t', 'SELECT 3'] },
      await bearer(env, 'a1', 'admin')
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { results: Array<{ error?: string; results: unknown[] }>; halted?: boolean }
    expect(body.results).toHaveLength(2)
    expect(body.results[0]!.results).toEqual([{ n: 1 }])
    expect(body.results[1]!.error).toBe('relation "t" does not exist')
    expect(body.halted).toBe(true)
    // The third statement never reached the session
    expect(pg.opened[0]!.runs).toHaveLength(2)
    expect(pg.opened[0]!.closed).toBe(true)
  })

  it('marks a truncated result', async () => {
    const env = await pgEnv()
    pg.queue.push({ results: [{ n: 1 }], truncated: true })
    const res = await post(env, '/api/query', { databaseId: 'pg1', sql: 'SELECT * FROM t' }, await bearer(env, 'u1'))
    expect(await res.json()).toMatchObject({ truncated: true })
  })

  it('passes SHOW through untranslated (MySQL compatibility is a sqlite-target feature)', async () => {
    const env = await pgEnv()
    pg.queue.push({ results: [{ server_version: '18.6' }] })
    const res = await post(
      env,
      '/api/query',
      { databaseId: 'pg1', sql: 'SHOW TABLES' },
      await bearer(env, 'a1', 'admin')
    )
    expect(res.status).toBe(200)
    expect(pg.opened[0]!.runs).toEqual([{ sql: 'SHOW TABLES', kind: 'read' }])
  })

  it('rejects destructive statements and file statements before opening a connection', async () => {
    const env = await pgEnv('write')
    for (const [sql, status] of [
      ['DROP TABLE t', 403],
      ['COPY t TO STDOUT', 403],
      ['SELECT 1; SELECT 2', 400],
    ] as const) {
      const res = await post(env, '/api/query', { databaseId: 'pg1', sql }, await bearer(env, 'u1'))
      expect(res.status, sql).toBe(status)
    }
    expect(pg.opened).toHaveLength(0)
  })

  it('reports a connection failure as a deployment error, with detail only for admins', async () => {
    const env = await pgEnv()
    pg.openError = { message: 'Wrong credentials for user "owner"', kind: 'auth' }

    const member = await post(env, '/api/query', { databaseId: 'pg1', sql: 'SELECT 1' }, await bearer(env, 'u1'))
    expect(member.status).toBe(500)
    expect(await member.json()).toEqual({ error: 'Database configuration error. Contact the admin.' })

    pg.openError = { message: 'Wrong credentials for user "owner"', kind: 'auth' }
    const admin = await post(
      env,
      '/api/query',
      { databaseId: 'pg1', sql: 'SELECT 1' },
      await bearer(env, 'a1', 'admin')
    )
    expect(admin.status).toBe(500)
    expect(((await admin.json()) as { error: string }).error).toContain('Wrong credentials for user "owner"')
    expect(pg.opened).toHaveLength(0)
  })

  it('refuses a postgres row whose stored connection is missing', async () => {
    const env = await pgEnv()
    await env.DB.prepare(`UPDATE d1_databases SET connection_secret = NULL WHERE id = 'pg1'`).run()
    const res = await post(env, '/api/query', { databaseId: 'pg1', sql: 'SELECT 1' }, await bearer(env, 'a1', 'admin'))
    expect(res.status).toBe(500)
    expect(((await res.json()) as { error: string }).error).toContain('no stored connection')
    expect(pg.opened).toHaveLength(0)
  })
})

describe('POST /api/query/probe (PostgreSQL)', () => {
  it('opens the stored target, runs one statement and closes it, writing no history', async () => {
    const env = await pgEnv('read')
    pg.queue.push({ results: [{ '?column?': 1 }] })
    const res = await post(env, '/api/query/probe', { databaseId: 'pg1' }, await bearer(env, 'u1'))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, kind: 'postgres' })
    expect(pg.opened).toHaveLength(1)
    expect(pg.opened[0]!.runs).toEqual([{ sql: 'select 1', kind: 'read' }])
    expect(pg.opened[0]!.closed).toBe(true)
    const history = await env.DB.prepare('SELECT COUNT(*) AS n FROM query_history').first<{ n: number }>()
    expect(history?.n).toBe(0)
  })

  it('reports a refused connection as a deployment error', async () => {
    const env = await pgEnv()
    pg.openError = { message: 'Authentication failed: password authentication failed', kind: 'auth' }
    const member = await post(env, '/api/query/probe', { databaseId: 'pg1' }, await bearer(env, 'u1'))
    expect(member.status).toBe(500)
    expect(await member.json()).toEqual({ error: 'Database configuration error. Contact the admin.' })

    pg.openError = { message: 'Authentication failed: password authentication failed', kind: 'auth' }
    const admin = await post(env, '/api/query/probe', { databaseId: 'pg1' }, await bearer(env, 'a1', 'admin'))
    expect(admin.status).toBe(500)
    expect(((await admin.json()) as { error: string }).error).toContain('Authentication failed')
  })
})
