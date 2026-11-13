import { afterEach, describe, expect, it, vi } from 'vitest'
import { getMigrations } from '../../lib/migrations'
import { sealSecret } from '../../lib/secrets'
import type { Permission } from '../../lib/sql-guard'
import type { Env } from '../../types'
import { bearer, callWorker, fakeEnv, postJson } from './fakes'
import { sqliteD1 } from './sqlite-d1'

// MySQL (TiDB Cloud Starter) targets on the query routes. The executor is replaced by a scripted
// session, so these tests check the wiring: the MySQL dialect, no MySQL-compatibility rewriting,
// permission checks, the `Executed` mapping and one driver connection per request.

type Run = { sql: string; kind: string }

const my = vi.hoisted(() => ({
  opened: [] as Array<{ url: string; runs: Run[]; closed: boolean }>,
  queue: [] as Array<{
    results?: unknown[]
    changes?: number
    truncated?: boolean
    error?: { message: string; kind: string }
  }>,
  openError: null as null | { message: string; kind: string },
}))

vi.mock('../../lib/mysql-executor', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/mysql-executor')>()
  return {
    ...actual,
    openMySqlSession: async (url: string) => {
      if (my.openError) {
        const pending = my.openError
        my.openError = null
        throw new actual.MySqlQueryError(pending.message, pending.kind as never)
      }
      const record = { url, runs: [] as Run[], closed: false }
      my.opened.push(record)
      return {
        async run(sql: string, kind: string) {
          record.runs.push({ sql, kind })
          const next = my.queue.shift()
          if (next?.error) throw new actual.MySqlQueryError(next.error.message, next.error.kind as never)
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

const PASSWORD = 'pw0rd'
const HOST = 'gateway01.us-east-1.prod.aws.tidbcloud.com'
const RAW_URL = `mysql://3Kx9aBcD.root:${PASSWORD}@${HOST}/zeta?ssl-mode=VERIFY_IDENTITY`
const STORED_URL = `mysql://3Kx9aBcD.root:${PASSWORD}@${HOST}:4000/zeta`

afterEach(() => {
  my.opened.length = 0
  my.queue.length = 0
  my.openError = null
})

// The app database is a real in-memory SQLite with the production schema, so the registry,
// permission and history statements all run for real.
async function myEnv(storedPermission: Permission = 'read'): Promise<Env> {
  const app = sqliteD1()
  for (const migration of getMigrations({ TABLE_PREFIX: '' })) app.sqlite.exec(migration.sql)
  const env = fakeEnv({ DB: app.db })
  const sealed = await sealSecret(env, JSON.stringify({ url: RAW_URL }))
  app.sqlite.exec(`
    INSERT INTO users (id, email, name, role, created_at, updated_at)
      VALUES ('u1', 'member@example.com', 'Member', 'member', 0, 0),
             ('a1', 'admin@example.com', 'Admin', 'admin', 0, 0);
    INSERT INTO d1_databases (id, name, binding_name, kind, connection_secret, is_active, created_at)
      VALUES ('my1', 'tidb', 'my:my1', 'mysql', '${sealed}', 1, 0);
    INSERT INTO user_database_permissions (id, user_id, database_id, permission, granted_at)
      VALUES ('p1', 'u1', 'my1', '${storedPermission}', 0);
  `)
  return env
}

const post = (env: Env, path: string, body: unknown, headers: Record<string, string>) =>
  callWorker(env, path, postJson(body, { headers }))

describe('query a MySQL target', () => {
  it('decrypts and re-normalises the stored connection, runs the read and closes the session', async () => {
    const env = await myEnv('read')
    my.queue.push({ results: [{ n: 1 }] })
    const res = await post(env, '/api/query', { databaseId: 'my1', sql: 'SELECT * FROM t' }, await bearer(env, 'u1'))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ results: [{ n: 1 }], truncated: false })
    expect(my.opened).toHaveLength(1)
    // The stored string is normalised again before the driver sees it (parameters dropped, port pinned)
    expect(my.opened[0]!.url).toBe(STORED_URL)
    // The row cap is applied inside the executor (limitReadSql, MySQL dialect)
    expect(my.opened[0]!.runs).toEqual([{ sql: 'SELECT * FROM t', kind: 'read' }])
    expect(my.opened[0]!.closed).toBe(true)
  })

  it('returns the affected row count for a write and no result rows', async () => {
    const env = await myEnv()
    my.queue.push({ changes: 3 })
    const res = await post(
      env,
      '/api/query',
      { databaseId: 'my1', sql: 'DELETE FROM t' },
      await bearer(env, 'a1', 'admin')
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ results: [], meta: { changes: 3 } })
    expect(my.opened[0]!.runs).toEqual([{ sql: 'DELETE FROM t', kind: 'write' }])
  })

  it('reuses one driver connection for a batch, in statement order, and closes it once', async () => {
    const env = await myEnv()
    my.queue.push({ results: [{ n: 1 }] }, { results: [{ n: 2 }] }, { results: [{ n: 3 }] })
    const res = await post(
      env,
      '/api/query/batch',
      { databaseId: 'my1', statements: ['SELECT 1', 'SELECT 2', 'SELECT 3'] },
      await bearer(env, 'a1', 'admin')
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { results: Array<{ results: unknown[] }> }
    expect(body.results.map((r) => r.results)).toEqual([[{ n: 1 }], [{ n: 2 }], [{ n: 3 }]])
    expect(my.opened).toHaveLength(1)
    expect(my.opened[0]!.runs).toHaveLength(3)
    expect(my.opened[0]!.closed).toBe(true)
  })

  it('records a failing statement in the batch and keeps going', async () => {
    const env = await myEnv()
    my.queue.push(
      { error: { message: "Error 1146 (42S02): Table 'zeta.t' doesn't exist", kind: 'sql' } },
      { results: [] }
    )
    const res = await post(
      env,
      '/api/query/batch',
      { databaseId: 'my1', statements: ['SELECT * FROM t', 'SELECT 1'] },
      await bearer(env, 'a1', 'admin')
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { results: Array<{ error?: string; results: unknown[] }> }
    expect(body.results[0]!.error).toContain('1146')
    expect(body.results[1]!.error).toBeUndefined()
  })

  it('marks a truncated result', async () => {
    const env = await myEnv()
    my.queue.push({ results: [{ n: 1 }], truncated: true })
    const res = await post(env, '/api/query', { databaseId: 'my1', sql: 'SELECT * FROM t' }, await bearer(env, 'u1'))
    expect(await res.json()).toMatchObject({ truncated: true })
  })

  it('passes SHOW TABLES through untranslated (MySQL compatibility is a sqlite-target feature)', async () => {
    const env = await myEnv()
    my.queue.push({ results: [{ Tables_in_zeta: 't' }] })
    const res = await post(
      env,
      '/api/query',
      { databaseId: 'my1', sql: 'SHOW TABLES' },
      await bearer(env, 'a1', 'admin')
    )
    expect(res.status).toBe(200)
    expect(my.opened[0]!.runs).toEqual([{ sql: 'SHOW TABLES', kind: 'read' }])
  })

  it('rejects destructive, multi-statement and MySQL-forbidden statements before opening a session', async () => {
    const env = await myEnv('write')
    for (const [sql, status] of [
      ['DROP TABLE t', 403],
      ['SELECT 1; SELECT 2', 400],
      ['LOAD DATA INFILE "/x" INTO TABLE t', 403],
      ['USE other', 403],
      ['SET @x = 1', 403],
      ['SELECT 1 /*! , 2 */', 403],
      ['SHOW PROCESSLIST', 403],
    ] as const) {
      const res = await post(env, '/api/query', { databaseId: 'my1', sql }, await bearer(env, 'u1'))
      expect(res.status, sql).toBe(status)
    }
    expect(my.opened).toHaveLength(0)
  })

  it('reports a connection failure as a deployment error, with detail only for admins', async () => {
    const env = await myEnv()
    my.openError = { message: 'Authentication failed: Access denied', kind: 'auth' }

    const member = await post(env, '/api/query', { databaseId: 'my1', sql: 'SELECT 1' }, await bearer(env, 'u1'))
    expect(member.status).toBe(500)
    expect(await member.json()).toEqual({ error: 'Database configuration error. Contact the admin.' })

    my.openError = { message: 'Authentication failed: Access denied', kind: 'auth' }
    const admin = await post(
      env,
      '/api/query',
      { databaseId: 'my1', sql: 'SELECT 1' },
      await bearer(env, 'a1', 'admin')
    )
    expect(admin.status).toBe(500)
    expect(((await admin.json()) as { error: string }).error).toContain('Access denied')
    expect(my.opened).toHaveLength(0)
  })

  it('shows a SQL error to everyone as a 400', async () => {
    const env = await myEnv()
    my.queue.push({ error: { message: "Error 1146 (42S02): Table 'zeta.nope' doesn't exist", kind: 'sql' } })
    const res = await post(env, '/api/query', { databaseId: 'my1', sql: 'SELECT * FROM nope' }, await bearer(env, 'u1'))
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toContain('1146')
  })

  it('refuses a mysql row whose stored connection is missing', async () => {
    const env = await myEnv()
    await env.DB.prepare(`UPDATE d1_databases SET connection_secret = NULL WHERE id = 'my1'`).run()
    const res = await post(env, '/api/query', { databaseId: 'my1', sql: 'SELECT 1' }, await bearer(env, 'a1', 'admin'))
    expect(res.status).toBe(500)
    expect(((await res.json()) as { error: string }).error).toContain('no stored connection')
    expect(my.opened).toHaveLength(0)
  })
})
