import type { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getMigrations } from '../../lib/migrations'
import type { Env } from '../../types'
import { bearer, callWorker, fakeEnv, postJson } from './fakes'
import { sqliteD1 } from './sqlite-d1'

// Real SQLite for both the app database and the queried database, so the rewritten
// MySQL statements (SHOW TABLES, DESCRIBE, …) run for real through /api/query.

const MEMBER = 'member-1'
const DB_1 = '22222222-2222-4222-8222-222222222222'
const APP_DB = '11111111-1111-4111-8111-111111111111'

afterEach(() => vi.unstubAllGlobals())

type Row = Record<string, unknown>
const rows = (sqlite: DatabaseSync, sql: string) => sqlite.prepare(sql).all() as Row[]

// Runs the SQL sent over the D1 HTTP API against the real target SQLite, returning the D1 HTTP
// response shape. A failed statement returns its error message instead of throwing.
function execTarget(
  sqlite: DatabaseSync,
  sql: string
): { results: Row[]; meta: Record<string, unknown> } | { error: string } {
  try {
    const stmt = sqlite.prepare(sql)
    if (stmt.columns().length > 0) return { results: stmt.all() as Row[], meta: { changes: 0 } }
    const r = stmt.run()
    return { results: [] as Row[], meta: { changes: Number(r.changes) } }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
}

function jsonResponse(payload: unknown) {
  return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

function setup() {
  const app = sqliteD1()
  app.sqlite.exec(getMigrations({ TABLE_PREFIX: '' }).find((m) => m.name === 'schema_v1')!.sql)
  app.sqlite.exec(`
    INSERT INTO users (id, email, name, role, created_at, updated_at) VALUES
      ('${MEMBER}', 'member@example.com', 'Member', 'member', 0, 0);
    INSERT INTO d1_databases (id, name, binding_name, cf_database_id, created_at) VALUES
      ('db-1', 'one', 'QUERY_DB_1', '${DB_1}', 0);
    INSERT INTO user_database_permissions (id, user_id, database_id, permission, granted_at)
      VALUES ('p1', '${MEMBER}', 'db-1', 'read', 0);
  `)

  const target = sqliteD1()
  target.sqlite.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL DEFAULT 'ann', email TEXT);
    CREATE UNIQUE INDEX idx_users_email ON users(email);
    CREATE TABLE _cf_KV (key TEXT);
    CREATE TABLE "quoted""name" (x INTEGER);
    CREATE VIEW v_users AS SELECT id, name FROM users;
    CREATE TABLE orders (a INTEGER NOT NULL, b TEXT, PRIMARY KEY (a, b));
    CREATE INDEX idx_orders_b ON orders(b);
  `)
  const executed: string[] = []

  const env = fakeEnv({ DB: app.db, CF_ACCOUNT_ID: 'acct', CLOUDFLARE_API_TOKEN: 'tok', ZETA_APP_DB_ID: APP_DB })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: unknown, init: RequestInit) => {
      const { sql } = JSON.parse(String(init.body)) as { sql: string }
      executed.push(sql)
      const res = execTarget(target.sqlite, sql)
      if ('error' in res) {
        return jsonResponse({ success: true, result: [{ success: false }], errors: [{ message: res.error }] })
      }
      return jsonResponse({ success: true, result: [{ success: true, results: res.results, meta: res.meta }] })
    })
  )

  return { env, app: app.sqlite, target: target.sqlite, executed }
}

async function query(env: Env, sql: string) {
  const res = await callWorker(
    env,
    '/api/query',
    postJson({ databaseId: 'db-1', sql }, { headers: await bearer(env, MEMBER) })
  )
  return { status: res.status, body: (await res.json()) as Row & { results: Row[] } }
}

async function batch(env: Env, statements: string[]) {
  const res = await callWorker(
    env,
    '/api/query/batch',
    postJson({ databaseId: 'db-1', statements }, { headers: await bearer(env, MEMBER) })
  )
  return { status: res.status, body: (await res.json()) as Row & { results: Array<Row & { results: Row[] }> } }
}

describe('MySQL compatibility layer through /api/query', () => {
  it('SHOW TABLES lists tables and views, excluding internal tables', async () => {
    const { env } = setup()
    const { status, body } = await query(env, 'SHOW TABLES')
    expect(status).toBe(200)
    expect(body.results.map((r) => r.name)).toEqual(['orders', 'quoted"name', 'users', 'v_users'])
  })

  it('DESCRIBE returns MySQL-style columns', async () => {
    const { env } = setup()
    const { status, body } = await query(env, 'DESCRIBE users')
    expect(status).toBe(200)
    expect(body.results).toEqual([
      { Field: 'id', Type: 'INTEGER', Null: 'YES', Key: 'PRI', Default: null, Extra: '' },
      { Field: 'name', Type: 'TEXT', Null: 'NO', Key: '', Default: "'ann'", Extra: '' },
      { Field: 'email', Type: 'TEXT', Null: 'YES', Key: '', Default: null, Extra: '' },
    ])
  })

  it('SHOW CREATE TABLE returns the DDL', async () => {
    const { env } = setup()
    const { status, body } = await query(env, 'SHOW CREATE TABLE users')
    expect(status).toBe(200)
    expect(body.results).toHaveLength(1)
    expect(body.results[0]).toMatchObject({ Table: 'users' })
    expect(String(body.results[0]!['Create Table'])).toMatch(/^CREATE TABLE users/)
  })

  it('SHOW CREATE TABLE matches names case-insensitively like SQLite identifiers', async () => {
    const { env } = setup()
    const { status, body } = await query(env, 'SHOW CREATE TABLE Users')
    expect(status).toBe(200)
    expect(body.results).toHaveLength(1)
    expect(body.results[0]).toMatchObject({ Table: 'users' })
  })

  it('SHOW INDEX returns index and PRIMARY key info', async () => {
    const { env } = setup()
    const { status, body } = await query(env, 'SHOW INDEX FROM orders')
    expect(status).toBe(200)
    expect(body.results).toEqual([
      expect.objectContaining({
        Table: 'orders',
        Non_unique: 0,
        Key_name: 'PRIMARY',
        Seq_in_index: 1,
        Column_name: 'a',
      }),
      expect.objectContaining({
        Table: 'orders',
        Non_unique: 0,
        Key_name: 'PRIMARY',
        Seq_in_index: 2,
        Column_name: 'b',
      }),
      expect.objectContaining({
        Table: 'orders',
        Non_unique: 1,
        Key_name: 'idx_orders_b',
        Seq_in_index: 1,
        Column_name: 'b',
      }),
    ])
    const unique = await query(env, 'SHOW INDEX FROM users')
    expect(unique.body.results).toEqual([
      expect.objectContaining({ Key_name: 'PRIMARY', Non_unique: 0, Seq_in_index: 1, Column_name: 'id' }),
      expect.objectContaining({ Key_name: 'idx_users_email', Non_unique: 0, Column_name: 'email' }),
    ])
  })

  it('accepts case, quoting and synonym variants', async () => {
    const { env } = setup()
    for (const sql of [
      'show tables;',
      'DESC `users`',
      'describe "users"',
      'SHOW COLUMNS FROM users',
      'SHOW COLUMNS IN users',
      'show create table users',
      'SHOW INDEXES FROM orders',
      'SHOW KEYS FROM orders',
      'SHOW INDEX IN orders',
    ]) {
      expect((await query(env, sql)).status).toBe(200)
    }
  })

  it('is read-only: a read user runs them and cannot write through them', async () => {
    const { env, target } = setup()
    expect((await query(env, 'DESCRIBE users')).status).toBe(200)
    // A table name that tries to smuggle a second statement is quoted, not executed
    const injected = await query(env, "DESCRIBE `x'; DROP TABLE users; --`")
    expect(injected.status).toBe(200)
    expect(injected.body.results).toEqual([])
    // The write never happened
    expect(rows(target, "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'users'")).toHaveLength(1)
  })

  it('rejects multi-statement MySQL input like any other multiple statement', async () => {
    const { env, executed } = setup()
    const { status } = await query(env, 'SHOW TABLES; DROP TABLE users')
    expect(status).toBe(400)
    expect(executed).toEqual([])
  })

  it('reports SHOW DATABASES as unsupported', async () => {
    const { env } = setup()
    const { status, body } = await query(env, 'SHOW DATABASES')
    expect(status).toBe(400)
    expect(body.error).toContain('SHOW DATABASES')
  })

  it('leaves unrecognised statements to the normal path', async () => {
    const { env } = setup()
    // SHOW VARIABLES is not translated: it stays a write, so a read user is denied
    expect((await query(env, 'SHOW VARIABLES')).status).toBe(403)
    // An unterminated quoted table name is invalid syntax, not a successful rewrite
    expect((await query(env, 'DESCRIBE `users')).status).toBeGreaterThanOrEqual(400)
    // Ordinary SQL is unaffected
    const select = await query(env, 'SELECT COUNT(*) AS n FROM users')
    expect(select.status).toBe(200)
    expect(select.body.results).toEqual([{ n: 0 }])
  })

  it('runs MySQL statements mixed into a batch', async () => {
    const { env } = setup()
    const { status, body } = await batch(env, ['SHOW TABLES', 'DESCRIBE users', 'SELECT 1 AS a'])
    expect(status).toBe(200)
    expect(body.results[0]!.results.map((r) => r.name)).toEqual(['orders', 'quoted"name', 'users', 'v_users'])
    expect(body.results[1]!.results[0]).toMatchObject({ Field: 'id' })
    expect(body.results[2]!.results).toEqual([{ a: 1 }])
  })

  it('records the original MySQL statement in history and runs', async () => {
    const { env, app } = setup()
    const single = await query(env, 'DESCRIBE users')
    expect(single.status).toBe(200)
    expect(rows(app, 'SELECT sql FROM query_history ORDER BY executed_at')).toEqual([{ sql: 'DESCRIBE users' }])

    await batch(env, ['SHOW TABLES'])
    const history = rows(app, 'SELECT sql FROM query_history ORDER BY executed_at')
    expect(history.map((r) => r.sql)).toEqual(['DESCRIBE users', 'SHOW TABLES'])
  })

  it('is capped by the 5000-row limit like any read', async () => {
    const { env, executed } = setup()
    await query(env, 'SHOW TABLES')
    // The rewritten SELECT is wrapped in LIMIT 5001
    expect(executed[0]).toMatch(/^SELECT \* FROM \(\nSELECT name\nFROM sqlite_master/)
    expect(executed[0]).toContain('LIMIT 5001')
  })
})
