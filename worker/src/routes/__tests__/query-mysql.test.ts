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
  opened: [] as Array<{ url: string; sessionDatabase: string | null; runs: Run[]; closed: boolean }>,
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
    openMySqlSession: async (url: string, sessionDatabase?: string | null) => {
      if (my.openError) {
        const pending = my.openError
        my.openError = null
        throw new actual.MySqlQueryError(pending.message, pending.kind as never)
      }
      const record = { url, sessionDatabase: sessionDatabase ?? null, runs: [] as Run[], closed: false }
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
      ['SET @x = 1', 403],
      ['SELECT 1 /*! , 2 */', 403],
      ['SHOW PROCESSLIST', 403],
    ] as const) {
      const res = await post(env, '/api/query', { databaseId: 'my1', sql }, await bearer(env, 'u1'))
      expect(res.status, sql).toBe(status)
    }
    expect(my.opened).toHaveLength(0)
  })

  it('lets a session statement through: USE reaches the executor as a read', async () => {
    // The B ruling allows `USE` (a session statement, neither a read nor a write); the executor pins the
    // registered database at every open, so one request's pick never leaks into the next.
    const env = await myEnv('read')
    my.queue.push({ results: [] })
    const res = await post(env, '/api/query', { databaseId: 'my1', sql: 'USE other' }, await bearer(env, 'u1'))
    expect(res.status).toBe(200)
    expect(my.opened[0]!.runs).toEqual([{ sql: 'USE other', kind: 'read' }])
  })

  it('pins the session database the request chose, in a single query and across a batch', async () => {
    const env = await myEnv('read')
    my.queue.push({ results: [{ n: 1 }] }, { results: [{ n: 1 }] }, { results: [{ n: 2 }] })

    const single = await post(
      env,
      '/api/query',
      { databaseId: 'my1', sql: 'SELECT * FROM t', sessionDatabase: ' analytics ' },
      await bearer(env, 'u1')
    )
    expect(single.status).toBe(200)
    // Trimmed before it reaches the executor
    expect(my.opened[0]!.sessionDatabase).toBe('analytics')

    const batch = await post(
      env,
      '/api/query/batch',
      { databaseId: 'my1', statements: ['SELECT 1', 'SELECT 2'], sessionDatabase: 'analytics' },
      await bearer(env, 'u1')
    )
    expect(batch.status).toBe(200)
    // One pin per request, not one per statement
    expect(my.opened).toHaveLength(2)
    expect(my.opened[1]!.sessionDatabase).toBe('analytics')
    expect(my.opened[1]!.runs).toHaveLength(2)
  })

  it('keeps the registered database when the field is absent or blank', async () => {
    const env = await myEnv('read')
    for (const sessionDatabase of [undefined, null, '', '   ']) {
      my.queue.push({ results: [] })
      const res = await post(
        env,
        '/api/query',
        { databaseId: 'my1', sql: 'SELECT 1', sessionDatabase },
        await bearer(env, 'u1')
      )
      expect(res.status, String(sessionDatabase)).toBe(200)
      expect(my.opened.at(-1)!.sessionDatabase, String(sessionDatabase)).toBeNull()
    }
  })

  it('refuses a session database it cannot use, before opening a session', async () => {
    const env = await myEnv('read')
    // A PostgreSQL row can be resolved as a target but takes no session database
    const sealed = await sealSecret(env, JSON.stringify({ url: 'postgres://u:p@example.com:5432/db' }))
    await env.DB.prepare(
      `INSERT INTO d1_databases (id, name, binding_name, kind, provider, connection_secret, is_active, created_at)
       VALUES ('pg1', 'neon', 'pg:pg1', 'postgres', NULL, ?1, 1, 0)`
    )
      .bind(sealed)
      .run()
    await env.DB.prepare(
      `INSERT INTO user_database_permissions (id, user_id, database_id, permission, granted_at)
       VALUES ('p2', 'u1', 'pg1', 'read', 0)`
    ).run()

    for (const [body, fragment] of [
      [{ databaseId: 'pg1', sql: 'SELECT 1', sessionDatabase: 'other' }, 'only supported for MySQL'],
      [{ databaseId: 'my1', sql: 'SELECT 1', sessionDatabase: 42 }, 'must be a string'],
      [{ databaseId: 'my1', sql: 'SELECT 1', sessionDatabase: 'd'.repeat(65) }, 'too long'],
    ] as const) {
      for (const path of ['/api/query', '/api/query/batch']) {
        const payload = path === '/api/query' ? body : { ...body, statements: ['SELECT 1'] }
        const res = await post(env, path, payload, await bearer(env, 'a1', 'admin'))
        expect(res.status, `${path} ${fragment}`).toBe(400)
        expect(((await res.json()) as { error: string }).error, path).toContain(fragment)
      }
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

describe('POST /api/query/probe (MySQL)', () => {
  it('opens the stored target, runs one statement and closes it', async () => {
    const env = await myEnv('read')
    my.queue.push({ results: [{ '1': 1 }] })
    const res = await post(env, '/api/query/probe', { databaseId: 'my1' }, await bearer(env, 'u1'))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, kind: 'mysql' })
    expect(my.opened).toHaveLength(1)
    expect(my.opened[0]!.url).toBe(STORED_URL)
    expect(my.opened[0]!.runs).toEqual([{ sql: 'select 1', kind: 'read' }])
    // A probe never carries a session database: it measures the registration as stored.
    expect(my.opened[0]!.sessionDatabase).toBeNull()
    expect(my.opened[0]!.closed).toBe(true)
  })

  it('needs a permission row for a member', async () => {
    const env = await myEnv('read')
    await env.DB.prepare(`DELETE FROM user_database_permissions WHERE database_id = 'my1'`).run()
    const res = await post(env, '/api/query/probe', { databaseId: 'my1' }, await bearer(env, 'u1'))
    expect(res.status).toBe(403)
    expect(my.opened).toHaveLength(0)
  })
})
