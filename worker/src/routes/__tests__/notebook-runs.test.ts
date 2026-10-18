import { describe, it, expect, vi, afterEach } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import init from '../../../migrations/0001_init.sql?raw'
import historyNullable from '../../../migrations/0002_history_nullable_refs.sql?raw'
import rateLimits from '../../../migrations/0003_rate_limits_history_set_null.sql?raw'
import notebookRuns from '../../../migrations/0004_notebook_runs.sql?raw'
import runSeq from '../../../migrations/0005_notebook_run_seq.sql?raw'
import cfDatabaseId from '../../../migrations/0006_d1_cf_database_id.sql?raw'
import type { Env } from '../../types'
import { bearer, callWorker, fakeEnv, postJson } from './fakes'
import { sqliteD1 } from './sqlite-d1'

// Real SQLite for both the app database (migrations 0001–0006) and the queried database, so the
// SQL-level row limit, the pruning window queries and the cascades run for real.

const ADMIN = 'admin-1'
const MEMBER = 'member-1' // read access to db-1
const OTHER = 'member-2'
const DB_1 = '22222222-2222-4222-8222-222222222222'
const APP_DB = '11111111-1111-4111-8111-111111111111'

afterEach(() => vi.unstubAllGlobals())

type Row = Record<string, unknown>
const rows = (sqlite: DatabaseSync, sql: string) => sqlite.prepare(sql).all() as Row[]
const count = (sqlite: DatabaseSync, sql: string) => Number(rows(sqlite, sql)[0]!.n)

const MIGRATIONS = [init, historyNullable, rateLimits, notebookRuns, runSeq, cfDatabaseId]
// Every migration except runSeq, to test a schema that predates run numbers.
const WITHOUT_RUN_SEQ = [init, historyNullable, rateLimits, notebookRuns, cfDatabaseId]

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

// `migrations` lets a test start from an older schema
function setup(migrations = MIGRATIONS) {
  const app = sqliteD1()
  for (const migration of migrations) app.sqlite.exec(migration)
  app.sqlite.exec(`
    INSERT INTO users (id, email, name, role, created_at, updated_at) VALUES
      ('${ADMIN}', 'admin@example.com', 'Admin', 'admin', 0, 0),
      ('${MEMBER}', 'member@example.com', 'Member', 'member', 0, 0),
      ('${OTHER}', 'other@example.com', 'Other', 'member', 0, 0);
    INSERT INTO d1_databases (id, name, binding_name, cf_database_id, created_at) VALUES
      ('db-1', 'one', 'QUERY_DB_1', '${DB_1}', 0);
    INSERT INTO user_database_permissions (id, user_id, database_id, permission, granted_at)
      VALUES ('p1', '${MEMBER}', 'db-1', 'read', 0);
    INSERT INTO notebooks (id, user_id, name, database_id, position, created_at, updated_at) VALUES
      ('nb-1', '${MEMBER}', 'One', 'db-1', 0, 0, 0),
      ('nb-2', '${MEMBER}', 'Two', 'db-1', 1, 0, 0),
      ('nb-other', '${OTHER}', 'Theirs', NULL, 0, 0, 0);
  `)

  // The queried database: t holds x = 1..6000. Every statement sent over HTTP is recorded.
  const target = sqliteD1()
  target.sqlite.exec(`
    CREATE TABLE t (x INTEGER);
    WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM r WHERE n < 6000) INSERT INTO t SELECT n FROM r;
  `)
  const executed: string[] = []

  const env = fakeEnv({ DB: app.db, CF_ACCOUNT_ID: 'acct', CF_D1_API_TOKEN: 'tok', ZETA_APP_DB_ID: APP_DB })
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

async function query(env: Env, body: Row, userId = MEMBER, role: 'admin' | 'member' = 'member') {
  const res = await callWorker(
    env,
    '/api/query',
    postJson({ databaseId: 'db-1', ...body }, { headers: await bearer(env, userId, role) })
  )
  return { status: res.status, body: (await res.json()) as Row & { results: Row[] } }
}

async function batch(env: Env, body: Row, userId = MEMBER) {
  const res = await callWorker(
    env,
    '/api/query/batch',
    postJson({ databaseId: 'db-1', ...body }, { headers: await bearer(env, userId) })
  )
  return { status: res.status, body: (await res.json()) as Row & { results: Array<Row & { results: Row[] }> } }
}

async function call(
  env: Env,
  path: string,
  method = 'GET',
  userId = MEMBER,
  role: 'admin' | 'member' = 'member',
  body?: unknown
) {
  const init: RequestInit = { method, headers: await bearer(env, userId, role) }
  if (body !== undefined) Object.assign(init, postJson(body, { method, headers: init.headers }))
  const res = await callWorker(env, path, init)
  return { status: res.status, body: (await res.json()) as Row }
}

// Stored runs inserted directly, with explicit times and sizes, numbered in the order given per
// notebook. `numbered = false` leaves seq out, for schemas older than migration 0005.
function seedRuns(
  app: DatabaseSync,
  runs: Array<{ id: string; nb?: string; at: number; bytes?: number; user?: string }>,
  numbered = true,
  table = 'notebook_runs'
) {
  const seq = numbered ? ', seq' : ''
  const next = numbered ? `, (SELECT COALESCE(MAX(seq), 0) + 1 FROM ${table} WHERE notebook_id = ?2)` : ''
  for (const r of runs) {
    app
      .prepare(
        `INSERT INTO ${table} (id, notebook_id, user_id, database_id, sql, statement_count, row_count, error_count,
           duration_ms, storage_truncated, results_bytes, executed_at, results${seq})
         VALUES (?1, ?2, ?3, 'db-1', 'SELECT 1', 1, 1, 0, 1, 0, ?4, ?5,
           '[{"sql":"SELECT 1","results":[{"1":1}],"duration_ms":1}]'${next})`
      )
      .run(r.id, r.nb ?? 'nb-1', r.user ?? MEMBER, r.bytes ?? 100, r.at)
  }
}

const runIds = (app: DatabaseSync, where = '1') =>
  rows(app, `SELECT id FROM notebook_runs WHERE ${where} ORDER BY executed_at`).map((r) => r.id)

describe('read queries are capped at 5000 rows by the database', () => {
  it('wraps the statement in LIMIT 5001 and reports the truncation', async () => {
    const { env, executed } = setup()
    const { status, body } = await query(env, { sql: 'SELECT * FROM t' })
    expect(status).toBe(200)
    expect(body.results).toHaveLength(5000)
    expect(body.truncated).toBe(true)
    expect(executed).toEqual(['SELECT * FROM (\nSELECT * FROM t\n) LIMIT 5001'])
  })

  it('keeps the smaller of the statement LIMIT and the cap', async () => {
    const { env } = setup()
    const small = await query(env, { sql: 'SELECT * FROM t LIMIT 10;' })
    expect(small.body.results).toHaveLength(10)
    expect(small.body.truncated).toBe(false)
    const large = await query(env, { sql: 'SELECT * FROM t LIMIT 8000' })
    expect(large.body.results).toHaveLength(5000)
    expect(large.body.truncated).toBe(true)
  })

  it('keeps ORDER BY and CTE results intact', async () => {
    const { env } = setup()
    const ordered = await query(env, { sql: 'SELECT x FROM t ORDER BY x DESC' })
    expect(ordered.body.results[0]).toEqual({ x: 6000 })
    expect(ordered.body.results.at(-1)).toEqual({ x: 1001 })

    const cte = await query(env, {
      sql: 'WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM r WHERE n < 6000) SELECT n * 2 AS d FROM r ORDER BY n DESC',
    })
    expect(cte.body.results).toHaveLength(5000)
    expect(cte.body.results[0]).toEqual({ d: 12000 })
    expect(cte.body.results.at(-1)).toEqual({ d: 2002 })
  })

  it('runs PRAGMA and EXPLAIN unwrapped', async () => {
    const { env, executed } = setup()
    const pragma = await query(env, { sql: 'PRAGMA table_info(t)' })
    expect(pragma.status).toBe(200)
    expect(pragma.body.results).toHaveLength(1)
    expect((await query(env, { sql: 'EXPLAIN QUERY PLAN SELECT * FROM t' })).status).toBe(200)
    expect(executed).toEqual(['PRAGMA table_info(t)', 'EXPLAIN QUERY PLAN SELECT * FROM t'])
  })

  it('does not let a read-only user write through the wrapper', async () => {
    const { env, target } = setup()
    for (const sql of ['SELECT 1) ; DELETE FROM t; SELECT (1', 'WITH x AS (SELECT 1) DELETE FROM t', 'DELETE FROM t']) {
      expect((await query(env, { sql })).status).toBeGreaterThanOrEqual(400)
    }
    expect(count(target, 'SELECT COUNT(*) AS n FROM t')).toBe(6000)
  })

  it('does not let unbalanced parentheses move the LIMIT into a subquery', async () => {
    const { env, executed } = setup()
    const sql = 'SELECT 1), t WHERE x IN (SELECT 1'
    expect((await query(env, { sql })).status).toBe(400)
    expect(executed).toEqual([sql])
  })

  it('caps every read statement of a batch', async () => {
    const { env } = setup()
    const { body } = await batch(env, { statements: ['SELECT * FROM t', 'SELECT * FROM t LIMIT 3'] })
    expect(body.results.map((r) => [r.results.length, r.truncated ?? false])).toEqual([
      [5000, true],
      [3, false],
    ])
  })
})

describe('saving runs', () => {
  it('saves single and batch runs under the notebook', async () => {
    const { env, app } = setup()
    const single = await query(env, { sql: 'SELECT x FROM t LIMIT 2', notebookId: 'nb-1' })
    expect(single.body).toMatchObject({ run_id: expect.any(String), executed_at: expect.any(Number) })
    const multi = await batch(env, { statements: ['SELECT 1 AS a', 'SELECT nope'], notebookId: 'nb-1' })
    expect(multi.body.run_id).toEqual(expect.any(String))

    const stored = rows(app, 'SELECT * FROM notebook_runs ORDER BY executed_at')
    expect(stored).toHaveLength(2)
    expect(stored[0]).toMatchObject({ id: single.body.run_id, notebook_id: 'nb-1', row_count: 2, error_count: 0 })
    expect(JSON.parse(stored[0]!.results as string)).toEqual([
      expect.objectContaining({ sql: 'SELECT x FROM t LIMIT 2', results: [{ x: 1 }, { x: 2 }] }),
    ])
    expect(stored[1]).toMatchObject({ statement_count: 2, error_count: 1 })
    expect(stored[1]!.results_bytes).toBe(new TextEncoder().encode(stored[1]!.results as string).length)
  })

  it('saves a failing statement together with its error', async () => {
    const { env, app } = setup()
    const { status, body } = await query(env, { sql: 'SELECT nope FROM t', notebookId: 'nb-1' })
    expect(status).toBe(400)
    expect(body.run_id).toEqual(expect.any(String))
    expect(rows(app, 'SELECT error_count FROM notebook_runs')).toEqual([{ error_count: 1 }])
  })

  it('does not save a batch whose statements were all rejected before running', async () => {
    const { env, app, executed } = setup()
    const { status, body } = await batch(env, { statements: ['DELETE FROM t', 'DROP TABLE t'], notebookId: 'nb-1' })
    expect(status).toBe(200)
    expect(body.run_id).toBeUndefined()
    expect(executed).toEqual([])
    expect(count(app, 'SELECT COUNT(*) AS n FROM notebook_runs')).toBe(0)
  })

  it('counts the rows a write changed', async () => {
    const { env, app } = setup()
    app.exec(`UPDATE user_database_permissions SET permission = 'write' WHERE id = 'p1'`)
    const res = await query(env, { sql: 'UPDATE t SET x = x WHERE x <= 3', notebookId: 'nb-1' })
    expect(res.status).toBe(200)
    expect(rows(app, 'SELECT row_count FROM notebook_runs')).toEqual([{ row_count: 3 }])
  })

  it("refuses another user's notebook without running anything", async () => {
    const { env, app, executed } = setup()
    expect((await query(env, { sql: 'SELECT 1', notebookId: 'nb-other' })).status).toBe(404)
    expect((await batch(env, { statements: ['SELECT 1'], notebookId: 'nb-other' })).status).toBe(404)
    expect(executed).toEqual([])
    expect(count(app, 'SELECT COUNT(*) AS n FROM notebook_runs')).toBe(0)
  })

  it('keeps only the newest runs up to the admin limit', async () => {
    const { env, app } = setup()
    app.exec(`UPDATE settings SET value = '2' WHERE key = 'notebook_run_limit'`)
    seedRuns(app, [
      { id: 'old-1', at: 1000 },
      { id: 'old-2', at: 2000 },
      { id: 'other-nb', nb: 'nb-2', at: 500 },
    ])
    const { body } = await query(env, { sql: 'SELECT 1', notebookId: 'nb-1' })
    expect(runIds(app, "notebook_id = 'nb-1'")).toEqual(['old-2', body.run_id])
    expect(runIds(app, "notebook_id = 'nb-2'")).toEqual(['other-nb'])
  })

  it('applies the lower of the user and admin limits', async () => {
    const { env, app } = setup()
    app.exec(`UPDATE users SET notebook_run_limit = 3 WHERE id = '${MEMBER}'`)
    seedRuns(
      app,
      [1, 2, 3, 4].map((i) => ({ id: `r${i}`, at: i * 1000 }))
    )
    const { body } = await query(env, { sql: 'SELECT 1', notebookId: 'nb-1' })
    expect(runIds(app)).toEqual(['r3', 'r4', body.run_id])
  })

  it('drops the oldest runs across notebooks once the storage quota is exceeded', async () => {
    const { env, app } = setup()
    app.exec(`UPDATE settings SET value = '1' WHERE key = 'run_storage_quota_mb'`)
    seedRuns(app, [
      { id: 'oldest', nb: 'nb-2', at: 1000, bytes: 400_000 },
      { id: 'middle', at: 2000, bytes: 400_000 },
      { id: 'newer', nb: 'nb-2', at: 3000, bytes: 400_000 },
      { id: 'someone-else', nb: 'nb-other', user: OTHER, at: 500, bytes: 900_000 },
    ])
    const { body } = await query(env, { sql: 'SELECT 1', notebookId: 'nb-1' })
    expect(runIds(app, `user_id = '${MEMBER}'`)).toEqual(['middle', 'newer', body.run_id])
    expect(runIds(app, `user_id = '${OTHER}'`)).toEqual(['someone-else'])
  })
})

describe('reading and deleting runs', () => {
  it('lists runs newest first without results, with paging', async () => {
    const { env, app } = setup()
    seedRuns(
      app,
      [1, 2, 3].map((i) => ({ id: `r${i}`, at: i * 1000 }))
    )
    const page = await call(env, '/api/notebooks/nb-1/runs?limit=2')
    expect(page.status).toBe(200)
    const results = page.body.results as Row[]
    expect(results.map((r) => r.id)).toEqual(['r3', 'r2'])
    expect(results[0]).toMatchObject({ database_name: 'one', accessible: true })
    expect(results[0]).not.toHaveProperty('results')
    expect(page.body.has_more).toBe(true)
    const rest = await call(env, '/api/notebooks/nb-1/runs?limit=2&offset=2')
    expect((rest.body.results as Row[]).map((r) => r.id)).toEqual(['r1'])
    expect(rest.body.has_more).toBe(false)
  })

  it('returns a run with its results', async () => {
    const { env, app } = setup()
    seedRuns(app, [{ id: 'r1', at: 1000 }])
    const { status, body } = await call(env, '/api/notebooks/nb-1/runs/r1')
    expect(status).toBe(200)
    expect(body).toMatchObject({ id: 'r1', results: [{ sql: 'SELECT 1', results: [{ 1: 1 }] }] })
  })

  it("only shows a notebook's runs to its owner", async () => {
    const { env, app } = setup()
    seedRuns(app, [{ id: 'r1', at: 1000 }])
    for (const [path, method] of [
      ['/api/notebooks/nb-1/runs', 'GET'],
      ['/api/notebooks/nb-1/runs/r1', 'GET'],
      ['/api/notebooks/nb-1/runs/r1', 'DELETE'],
      ['/api/notebooks/nb-1/runs', 'DELETE'],
    ] as const) {
      expect((await call(env, path, method, OTHER)).status).toBe(404)
      expect((await call(env, path, method, ADMIN, 'admin')).status).toBe(404)
    }
    expect(runIds(app)).toEqual(['r1'])
  })

  it('deletes one run or clears the notebook', async () => {
    const { env, app } = setup()
    seedRuns(app, [
      { id: 'r1', at: 1000 },
      { id: 'r2', at: 2000 },
      { id: 'r3', nb: 'nb-2', at: 3000 },
    ])
    expect((await call(env, '/api/notebooks/nb-1/runs/r1', 'DELETE')).status).toBe(200)
    expect((await call(env, '/api/notebooks/nb-1/runs/r1', 'DELETE')).status).toBe(404)
    expect((await call(env, '/api/notebooks/nb-1/runs/r3', 'DELETE')).status).toBe(404)
    expect((await call(env, '/api/notebooks/nb-1/runs', 'DELETE')).status).toBe(200)
    expect(runIds(app)).toEqual(['r3'])
  })

  it('hides results once the database is no longer accessible', async () => {
    const { env, app } = setup()
    seedRuns(app, [{ id: 'r1', at: 1000 }])
    app.exec(`UPDATE d1_databases SET is_active = 0 WHERE id = 'db-1'`)
    expect((await call(env, '/api/notebooks/nb-1/runs/r1')).status).toBe(403)
    const list = await call(env, '/api/notebooks/nb-1/runs')
    expect((list.body.results as Row[])[0]).toMatchObject({ id: 'r1', accessible: false })
  })

  it("deletes the user's runs when their access to the database is revoked", async () => {
    const { env, app } = setup()
    seedRuns(app, [
      { id: 'mine', at: 1000 },
      { id: 'theirs', nb: 'nb-other', user: OTHER, at: 1000 },
    ])
    const res = await call(env, `/api/admin/databases/db-1/permissions/${MEMBER}`, 'DELETE', ADMIN, 'admin')
    expect(res.status).toBe(200)
    expect(runIds(app)).toEqual(['theirs'])
  })

  it('removes runs with their notebook, database or user', async () => {
    const { env, app } = setup()
    seedRuns(app, [
      { id: 'nb1', at: 1000 },
      { id: 'nb2', nb: 'nb-2', at: 1000 },
      { id: 'other', nb: 'nb-other', user: OTHER, at: 1000 },
    ])
    expect((await call(env, '/api/notebooks/nb-1', 'DELETE')).status).toBe(200)
    expect(runIds(app)).toEqual(['nb2', 'other'])
    expect((await call(env, `/api/admin/users/${OTHER}`, 'DELETE', ADMIN, 'admin')).status).toBe(200)
    expect(runIds(app)).toEqual(['nb2'])
    expect((await call(env, '/api/admin/databases/db-1', 'DELETE', ADMIN, 'admin')).status).toBe(200)
    expect(runIds(app)).toEqual([])
  })
})

describe('run settings', () => {
  it('lets a user lower their own limit, not exceed the admin one', async () => {
    const { env, app } = setup()
    seedRuns(
      app,
      [1, 2, 3, 4, 5].map((i) => ({ id: `r${i}`, at: i * 1000, bytes: 1000 }))
    )
    for (const run_limit of [0, 101, '3', 2.5, -1]) {
      expect((await call(env, '/api/profile/run-settings', 'PUT', MEMBER, 'member', { run_limit })).status).toBe(400)
    }
    expect((await call(env, '/api/profile/run-settings', 'PUT', MEMBER, 'member', {})).status).toBe(400)

    const res = await call(env, '/api/profile/run-settings', 'PUT', MEMBER, 'member', { run_limit: 3 })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      run_limit: 3,
      admin_run_limit: 100,
      effective_run_limit: 3,
      storage_used_bytes: 3000,
      storage_quota_bytes: 50 * 1024 * 1024,
    })
    expect(runIds(app)).toEqual(['r3', 'r4', 'r5'])

    const reset = await call(env, '/api/profile/run-settings', 'PUT', MEMBER, 'member', { run_limit: null })
    expect(reset.body).toMatchObject({ run_limit: null, effective_run_limit: 100 })
    expect((await call(env, '/api/profile/run-settings')).body.storage_used_bytes).toBe(3000)
  })

  it('validates the admin limits and applies lower ones to everybody at once', async () => {
    const { env, app } = setup()
    const patch = (body: Row) => call(env, '/api/admin/settings', 'PATCH', ADMIN, 'admin', body)
    for (const body of [
      { notebook_run_limit: '0' },
      { notebook_run_limit: '1001' },
      { notebook_run_limit: 'abc' },
      { run_storage_quota_mb: '0' },
      { run_storage_quota_mb: '1025' },
    ]) {
      expect((await patch(body)).status).toBe(400)
    }

    app.exec(`UPDATE users SET notebook_run_limit = 50 WHERE id = '${MEMBER}'`)
    seedRuns(app, [
      { id: 'a1', at: 1000 },
      { id: 'a2', at: 2000 },
      { id: 'a3', at: 3000 },
      { id: 'b1', nb: 'nb-other', user: OTHER, at: 1000 },
      { id: 'b2', nb: 'nb-other', user: OTHER, at: 2000 },
    ])
    expect((await patch({ notebook_run_limit: '1' })).status).toBe(200)
    expect(runIds(app)).toEqual(['b2', 'a3'])
    // The member's own (higher) value is kept but capped by the admin limit
    expect((await call(env, '/api/profile/run-settings')).body).toMatchObject({ run_limit: 50, effective_run_limit: 1 })
    expect((await call(env, '/api/admin/settings', 'GET', ADMIN, 'admin')).body).toMatchObject({
      notebook_run_limit: '1',
      run_storage_quota_mb: '50',
    })
  })
})

describe('setup', () => {
  const runSetup = async (env: Env) => {
    const res = await callWorker(env, '/api/setup', postJson({ secret: 'test-setup-secret' }))
    return (await res.json()) as Row
  }

  it('creates the runs table, its indexes and default limits with a prefix', async () => {
    const { db, sqlite } = sqliteD1()
    expect(await runSetup(fakeEnv({ DB: db, TABLE_PREFIX: 'kp' }))).toMatchObject({ ok: true })
    const indexes = rows(
      sqlite,
      `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'kp_notebook_runs' AND sql IS NOT NULL`
    )
    expect(indexes.map((r) => r.name).sort()).toEqual(['idx_kp_notebook_runs_seq', 'idx_kp_notebook_runs_user'])
    expect(
      rows(
        sqlite,
        `SELECT key, value FROM kp_settings WHERE key IN ('notebook_run_limit', 'run_storage_quota_mb') ORDER BY key`
      )
    ).toEqual([
      { key: 'notebook_run_limit', value: '100' },
      { key: 'run_storage_quota_mb', value: '50' },
    ])
    expect(rows(sqlite, 'PRAGMA table_info(kp_users)').some((c) => c.name === 'notebook_run_limit')).toBe(true)
  })

  it('adds the user limit column to an older users table once', async () => {
    const { db, sqlite } = sqliteD1()
    sqlite.exec(`CREATE TABLE kp_users (
      id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT, name TEXT NOT NULL DEFAULT '',
      role TEXT NOT NULL DEFAULT 'member', email_verified INTEGER NOT NULL DEFAULT 0,
      two_factor_required INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`)
    const env = fakeEnv({ DB: db, TABLE_PREFIX: 'kp' })
    expect(await runSetup(env)).toMatchObject({ ok: true, upgraded: ['kp_users: added notebook_run_limit'] })
    expect(rows(sqlite, 'PRAGMA table_info(kp_users)').some((c) => c.name === 'notebook_run_limit')).toBe(true)
    expect(await runSetup(env)).not.toHaveProperty('upgraded')
  })
})

describe('run numbers', () => {
  const seqs = (app: DatabaseSync, nb = 'nb-1') =>
    rows(app, `SELECT seq FROM notebook_runs WHERE notebook_id = '${nb}' ORDER BY seq`).map((r) => r.seq)
  const listed = async (env: Env, qs = '') => {
    const { body } = await call(env, `/api/notebooks/nb-1/runs${qs}`)
    return { seqs: (body.results as Row[]).map((r) => r.seq), hasMore: body.has_more }
  }

  it('numbers the runs of each notebook from 1 and returns the number', async () => {
    const { env, app } = setup()
    expect((await query(env, { sql: 'SELECT 1', notebookId: 'nb-1' })).body.seq).toBe(1)
    expect((await query(env, { sql: 'SELECT nope', notebookId: 'nb-1' })).body.seq).toBe(2)
    expect((await batch(env, { statements: ['SELECT 1', 'SELECT 2'], notebookId: 'nb-1' })).body.seq).toBe(3)
    expect((await query(env, { sql: 'SELECT 1', notebookId: 'nb-2' })).body.seq).toBe(1)
    expect(seqs(app)).toEqual([1, 2, 3])
    expect(seqs(app, 'nb-2')).toEqual([1])
    expect((await listed(env)).seqs).toEqual([3, 2, 1])
    expect(rows(app, `SELECT id, last_run_seq FROM notebooks ORDER BY id`)).toEqual([
      { id: 'nb-1', last_run_seq: 3 },
      { id: 'nb-2', last_run_seq: 1 },
      { id: 'nb-other', last_run_seq: 0 },
    ])
  })

  it('never hands out a number again after deleting the newest run or clearing the list', async () => {
    const { env, app } = setup()
    for (let i = 0; i < 3; i++) await query(env, { sql: 'SELECT 1', notebookId: 'nb-1' })
    const [newest] = rows(app, `SELECT id FROM notebook_runs WHERE seq = 3`)
    expect((await call(env, `/api/notebooks/nb-1/runs/${newest!.id}`, 'DELETE')).status).toBe(200)
    expect((await query(env, { sql: 'SELECT 1', notebookId: 'nb-1' })).body.seq).toBe(4)
    expect(seqs(app)).toEqual([1, 2, 4])

    expect((await call(env, '/api/notebooks/nb-1/runs', 'DELETE')).status).toBe(200)
    expect((await query(env, { sql: 'SELECT 1', notebookId: 'nb-1' })).body.seq).toBe(5)
    expect(seqs(app)).toEqual([5])
  })

  it('keeps the numbers of the remaining runs when old ones are pruned', async () => {
    const { env, app } = setup()
    app.exec(`UPDATE settings SET value = '2' WHERE key = 'notebook_run_limit'`)
    for (let i = 0; i < 4; i++) await query(env, { sql: 'SELECT 1', notebookId: 'nb-1' })
    expect(seqs(app)).toEqual([3, 4])
    expect((await listed(env)).seqs).toEqual([4, 3])

    // Lowering a user's own limit prunes by number too
    expect((await call(env, '/api/profile/run-settings', 'PUT', MEMBER, 'member', { run_limit: 1 })).status).toBe(200)
    expect(seqs(app)).toEqual([4])
    expect((await query(env, { sql: 'SELECT 1', notebookId: 'nb-1' })).body.seq).toBe(5)
  })

  it('gives concurrent runs distinct numbers', async () => {
    const { env, app } = setup()
    const responses = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        i % 2
          ? query(env, { sql: `SELECT ${i}`, notebookId: 'nb-1' })
          : batch(env, { statements: [`SELECT ${i}`, 'SELECT 0'], notebookId: 'nb-1' })
      )
    )
    const numbers = responses.map((r) => r.body.seq as number).sort((a, b) => a - b)
    expect(numbers).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    expect(seqs(app)).toEqual(numbers)
    // The database itself refuses a duplicate number
    seedRuns(app, [{ id: 'dup', at: 1 }])
    expect(() => app.exec(`UPDATE notebook_runs SET seq = 1 WHERE id = 'dup'`)).toThrow(/UNIQUE/)
  })

  it('uses up no number for a batch that runs nothing', async () => {
    const { env } = setup()
    expect((await batch(env, { statements: ['DELETE FROM t'], notebookId: 'nb-1' })).body.seq).toBeUndefined()
    expect((await query(env, { sql: 'SELECT 1', notebookId: 'nb-1' })).body.seq).toBe(1)
  })

  it('pages below a number, unaffected by deletions in between', async () => {
    const { env, app } = setup()
    seedRuns(
      app,
      [1, 2, 3, 4, 5].map((i) => ({ id: `r${i}`, at: i * 1000 }))
    )
    expect(await listed(env, '?limit=2')).toEqual({ seqs: [5, 4], hasMore: true })
    await call(env, '/api/notebooks/nb-1/runs/r5', 'DELETE')
    expect(await listed(env, '?limit=2&before=4')).toEqual({ seqs: [3, 2], hasMore: true })
    expect(await listed(env, '?limit=2&before=2')).toEqual({ seqs: [1], hasMore: false })
  })

  it('numbers existing runs oldest first when migrating', async () => {
    const { env, app } = setup(WITHOUT_RUN_SEQ)
    seedRuns(
      app,
      [
        { id: 'b', at: 1000 },
        { id: 'a', at: 1000 }, // same time: ordered by id
        { id: 'c', at: 500 },
        { id: 'd', nb: 'nb-2', at: 3000 },
      ],
      false
    )
    app.exec(runSeq)
    expect(rows(app, 'SELECT id, seq FROM notebook_runs ORDER BY notebook_id, seq')).toEqual([
      { id: 'c', seq: 1 },
      { id: 'a', seq: 2 },
      { id: 'b', seq: 3 },
      { id: 'd', seq: 1 },
    ])
    expect(rows(app, 'SELECT last_run_seq AS n FROM notebooks ORDER BY id').map((r) => r.n)).toEqual([3, 1, 0])
    expect((await query(env, { sql: 'SELECT 1', notebookId: 'nb-1' })).body.seq).toBe(4)
  })

  it('still runs queries, unsaved, until the schema has run numbers', async () => {
    const { env, app } = setup(WITHOUT_RUN_SEQ)
    const single = await query(env, { sql: 'SELECT 1 AS a', notebookId: 'nb-1' })
    expect(single.status).toBe(200)
    expect(single.body.results).toEqual([{ a: 1 }])
    expect(single.body).not.toHaveProperty('run_id')
    const multi = await batch(env, { statements: ['SELECT 1', 'SELECT 2'], notebookId: 'nb-1' })
    expect(multi.status).toBe(200)
    expect(multi.body).not.toHaveProperty('run_id')
    expect(count(app, 'SELECT COUNT(*) AS n FROM notebook_runs')).toBe(0)
    expect((await query(env, { sql: 'SELECT 1', notebookId: 'nb-other' })).status).toBe(404)
  })
})

describe('setup: run numbers', () => {
  const runSetup = async (env: Env) => {
    const res = await callWorker(env, '/api/setup', postJson({ secret: 'test-setup-secret' }))
    return (await res.json()) as Row
  }
  const indexes = (sqlite: DatabaseSync) =>
    rows(sqlite, `SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'kp_notebook_runs'`)

  // A prefixed database as set up before run numbers existed, with runs in two notebooks
  async function olderDatabase() {
    const { db, sqlite } = sqliteD1()
    const env = fakeEnv({ DB: db, TABLE_PREFIX: 'kp' })
    expect(await runSetup(env)).toMatchObject({ ok: true })
    sqlite.exec(`
      DROP INDEX idx_kp_notebook_runs_seq;
      ALTER TABLE kp_notebook_runs DROP COLUMN seq;
      ALTER TABLE kp_notebooks DROP COLUMN last_run_seq;
      CREATE INDEX idx_kp_notebook_runs_notebook ON kp_notebook_runs(notebook_id, executed_at);
      INSERT INTO kp_users (id, email, name, role, created_at, updated_at) VALUES ('${MEMBER}', 'm@example.com', 'M', 'member', 0, 0);
      INSERT INTO kp_d1_databases (id, name, binding_name, created_at) VALUES ('db-1', 'one', 'QUERY_DB_1', 0);
      INSERT INTO kp_notebooks (id, user_id, name, position, created_at, updated_at) VALUES
        ('nb-1', '${MEMBER}', 'One', 0, 0, 0), ('nb-2', '${MEMBER}', 'Two', 1, 0, 0);
    `)
    seedRuns(
      sqlite,
      [
        { id: 'r2', at: 2000 },
        { id: 'r1', at: 1000 },
        { id: 'x1', nb: 'nb-2', at: 1500 },
      ],
      false,
      'kp_notebook_runs'
    )
    return { env, sqlite }
  }

  it('adds and backfills the numbers once, with the unique index', async () => {
    const { env, sqlite } = await olderDatabase()
    expect(await runSetup(env)).toMatchObject({
      ok: true,
      upgraded: ['kp_notebook_runs: added seq, kp_notebooks.last_run_seq; numbered 3 saved run(s)'],
    })
    expect(rows(sqlite, 'SELECT id, seq FROM kp_notebook_runs ORDER BY notebook_id, seq')).toEqual([
      { id: 'r1', seq: 1 },
      { id: 'r2', seq: 2 },
      { id: 'x1', seq: 1 },
    ])
    expect(rows(sqlite, 'SELECT id, last_run_seq FROM kp_notebooks ORDER BY id')).toEqual([
      { id: 'nb-1', last_run_seq: 2 },
      { id: 'nb-2', last_run_seq: 1 },
    ])
    const idx = indexes(sqlite).filter((i) => i.sql !== null)
    expect(idx.map((i) => i.name).sort()).toEqual(['idx_kp_notebook_runs_seq', 'idx_kp_notebook_runs_user'])
    expect(idx.find((i) => i.name === 'idx_kp_notebook_runs_seq')!.sql).toMatch(/^CREATE UNIQUE INDEX/)

    // Idempotent
    expect(await runSetup(env)).not.toHaveProperty('upgraded')
    expect(rows(sqlite, 'SELECT seq FROM kp_notebook_runs ORDER BY notebook_id, seq').map((r) => r.seq)).toEqual([
      1, 2, 1,
    ])
  })

  it('numbers runs saved by an older Worker after the highest number', async () => {
    const { env, sqlite } = await olderDatabase()
    await runSetup(env)
    seedRuns(sqlite, [{ id: 'late', at: 500 }], false, 'kp_notebook_runs')
    expect(await runSetup(env)).toMatchObject({ upgraded: ['kp_notebook_runs: numbered 1 saved run(s)'] })
    expect(rows(sqlite, `SELECT seq FROM kp_notebook_runs WHERE id = 'late'`)).toEqual([{ seq: 3 }])
    expect(rows(sqlite, `SELECT last_run_seq FROM kp_notebooks WHERE id = 'nb-1'`)).toEqual([{ last_run_seq: 3 }])
    expect(await runSetup(env)).not.toHaveProperty('upgraded')
  })
})
