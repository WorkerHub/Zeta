import { describe, it, expect } from 'vitest'
import { callWorker, fakeD1, fakeEnv, postJson } from './fakes'

describe('setup endpoint', () => {
  it('initialises the schema via POST with the secret in the body', async () => {
    const { db, calls } = fakeD1()
    const res = await callWorker(fakeEnv({ DB: db }), '/api/setup', postJson({ secret: 'test-setup-secret' }))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true })
    expect(calls.some((c) => c.sql.includes('CREATE TABLE IF NOT EXISTS users'))).toBe(true)
    expect(calls.some((c) => c.sql.includes('INSERT OR IGNORE INTO settings'))).toBe(true)
    expect(calls.some((c) => c.sql.includes('CREATE TABLE IF NOT EXISTS rate_limits'))).toBe(true)
  })

  it('initialises under the default zeta_ prefix and reports it when TABLE_PREFIX is unset', async () => {
    const { db, calls } = fakeD1()
    const res = await callWorker(
      fakeEnv({ DB: db, TABLE_PREFIX: undefined }),
      '/api/setup',
      postJson({ secret: 'test-setup-secret' })
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body).toMatchObject({ ok: true, tablePrefix: 'zeta_' })
    expect(typeof body.message === 'string' && body.message.includes('zeta_')).toBe(true)
    expect(calls.some((c) => c.sql.includes('CREATE TABLE IF NOT EXISTS zeta_users'))).toBe(true)
    expect(calls.some((c) => c.sql.includes('INSERT OR IGNORE INTO zeta_settings'))).toBe(true)
    expect(calls.some((c) => c.sql.includes('CREATE TABLE IF NOT EXISTS zeta_rate_limits'))).toBe(true)
    // The schema inspection of the anti-silent-switch guard runs before any DDL
    const guardIdx = calls.findIndex((c) => c.sql === "SELECT name FROM sqlite_master WHERE type = 'table'")
    const ddlIdx = calls.findIndex((c) => c.sql.includes('CREATE TABLE IF NOT EXISTS zeta_users'))
    expect(guardIdx).toBeGreaterThan(-1)
    expect(ddlIdx).toBeGreaterThan(guardIdx)
  })

  it('seeds registration as closed (the first account can still register)', async () => {
    const { db, calls } = fakeD1()
    await callWorker(fakeEnv({ DB: db }), '/api/setup', postJson({ secret: 'test-setup-secret' }))
    const seed = calls.find(
      (c) => c.sql.startsWith('INSERT OR IGNORE INTO settings') && c.args[0] === 'registration_enabled'
    )
    expect(seed?.args[1]).toBe('false')
  })

  it('does nothing for the legacy GET /api/setup/:secret form, even with the right secret', async () => {
    const { db, calls } = fakeD1()
    const res = await callWorker(fakeEnv({ DB: db }), '/api/setup/test-setup-secret')
    expect(res.status).toBe(405)
    expect(res.headers.get('Allow')).toBe('POST')
    expect(calls).toHaveLength(0)
  })

  it('rejects a wrong secret without initialising the schema', async () => {
    const { db, calls } = fakeD1()
    for (const secret of ['wrong', 'test-setup-secre', 'test-setup-secret-and-more']) {
      const res = await callWorker(fakeEnv({ DB: db }), '/api/setup', postJson({ secret }))
      expect(res.status).toBe(403)
    }
    // Only the per-attempt rate-limit counters are written; the schema is never touched.
    expect(calls.filter((c) => !c.sql.includes('rate_limits'))).toHaveLength(0)
  })

  it('requires a JSON body with a string secret', async () => {
    const env = fakeEnv()
    expect((await callWorker(env, '/api/setup', { method: 'POST' })).status).toBe(400)
    expect((await callWorker(env, '/api/setup', postJson({ secret: 123 }))).status).toBe(400)
    expect((await callWorker(env, '/api/setup', postJson({}))).status).toBe(400)
  })

  it('refuses to run when SETUP_SECRET is not configured', async () => {
    const { db, calls } = fakeD1()
    const res = await callWorker(fakeEnv({ DB: db, SETUP_SECRET: '' }), '/api/setup', postJson({ secret: 'x' }))
    expect(res.status).toBe(500)
    expect(calls.filter((c) => !c.sql.includes('rate_limits'))).toHaveLength(0)
  })

  describe('POST /api/setup rate limiting', () => {
    const attempt = (ip?: string) => postJson({ secret: 'wrong' }, ip ? { headers: { 'cf-connecting-ip': ip } } : {})

    it('returns 429 with Retry-After once an IP exceeds 3 attempts', async () => {
      const { db } = fakeD1()
      const env = fakeEnv({ DB: db })
      for (let i = 0; i < 3; i++) {
        expect((await callWorker(env, '/api/setup', attempt('203.0.113.9'))).status).toBe(403)
      }
      const blocked = await callWorker(env, '/api/setup', attempt('203.0.113.9'))
      expect(blocked.status).toBe(429)
      expect(await blocked.json()).toEqual({ error: 'Too many setup attempts. Try again later.' })
      expect(Number(blocked.headers.get('Retry-After'))).toBeGreaterThan(0)
    })

    it('counts a successful setup too, against the same counter as failures', async () => {
      const { db } = fakeD1()
      const env = fakeEnv({ DB: db })
      expect((await callWorker(env, '/api/setup', postJson({ secret: 'test-setup-secret' }))).status).toBe(200)
      for (let i = 0; i < 2; i++) {
        expect((await callWorker(env, '/api/setup', postJson({ secret: 'wrong' }))).status).toBe(403)
      }
      // 1 success + 2 failures = 3 attempts; the next one is throttled even with the right secret.
      expect((await callWorker(env, '/api/setup', postJson({ secret: 'test-setup-secret' }))).status).toBe(429)
    })

    it('keeps per-IP counters independent', async () => {
      const { db } = fakeD1()
      const env = fakeEnv({ DB: db })
      for (let i = 0; i < 3; i++) {
        await callWorker(env, '/api/setup', attempt('203.0.113.1'))
      }
      expect((await callWorker(env, '/api/setup', attempt('203.0.113.1'))).status).toBe(429)
      expect((await callWorker(env, '/api/setup', attempt('203.0.113.2'))).status).toBe(403)
    })
  })

  describe('GET /api/setup/state', () => {
    it('reports enabled when the settings table does not exist yet', async () => {
      const { db } = fakeD1((sql) => {
        if (sql.includes('FROM settings')) throw new Error('no such table: settings')
        return null
      })
      const res = await callWorker(fakeEnv({ DB: db }), '/api/setup/state')
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ enabled: true })
    })

    it('reports enabled by default when the row is absent', async () => {
      const { db } = fakeD1(() => null)
      const res = await callWorker(fakeEnv({ DB: db }), '/api/setup/state')
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ enabled: true })
    })

    it('reads the settings table under the default prefix when TABLE_PREFIX is unset', async () => {
      const { db, calls } = fakeD1(() => null)
      const res = await callWorker(fakeEnv({ DB: db, TABLE_PREFIX: undefined }), '/api/setup/state')
      expect(res.status).toBe(200)
      expect(calls.some((c) => c.sql.includes('FROM zeta_settings'))).toBe(true)
    })

    it('reflects the toggle: 0 → false, 1 → true (not swallowed by the 405 fallback)', async () => {
      for (const [value, enabled] of [
        ['0', false],
        ['1', true],
      ] as const) {
        const { db } = fakeD1((sql) => (sql.includes('FROM settings') ? { value } : null))
        const res = await callWorker(fakeEnv({ DB: db }), '/api/setup/state')
        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({ enabled })
      }
    })
  })

  describe('query_history upgrade', () => {
    // Answers PRAGMA table_info for every table; the users, notebooks and notebook_runs tables
    // already have their newest columns
    const tableInfo = (notnull: number) => [
      { name: 'id', notnull: 0 },
      { name: 'user_id', notnull },
      { name: 'database_id', notnull },
      { name: 'sql', notnull: 1 },
      { name: 'notebook_run_limit', notnull: 0 },
      { name: 'last_run_seq', notnull: 1 },
      { name: 'seq', notnull: 0 },
      { name: 'cf_database_id', notnull: 0 },
    ]
    const foreignKeys = (onDelete: string) => [
      { from: 'user_id', table: 'users', on_delete: onDelete },
      { from: 'database_id', table: 'd1_databases', on_delete: onDelete },
    ]

    it('rebuilds a history table created by older versions with NOT NULL refs', async () => {
      const { db, calls } = fakeD1((sql) => (sql.startsWith('PRAGMA table_info') ? tableInfo(1) : null))
      const res = await callWorker(fakeEnv({ DB: db }), '/api/setup', postJson({ secret: 'test-setup-secret' }))
      expect(res.status).toBe(200)
      expect(await res.json()).toMatchObject({ ok: true, upgraded: [expect.stringContaining('query_history')] })

      const sqls = calls.map((c) => c.sql.replace(/\s+/g, ' '))
      const start = sqls.indexOf('DROP TABLE IF EXISTS query_history_new')
      expect(start).toBeGreaterThan(-1)
      const rebuild = sqls.slice(start)
      expect(rebuild[1]).toMatch(
        /^CREATE TABLE IF NOT EXISTS query_history_new \( id TEXT PRIMARY KEY, user_id TEXT REFERENCES users\(id\) ON DELETE SET NULL, database_id TEXT REFERENCES d1_databases\(id\) ON DELETE SET NULL,/
      )
      expect(rebuild[2]).toMatch(/^INSERT INTO query_history_new \(.+\) SELECT .+ FROM query_history$/)
      expect(rebuild[3]).toBe('DROP TABLE query_history')
      expect(rebuild[4]).toBe('ALTER TABLE query_history_new RENAME TO query_history')
      expect(rebuild.slice(5, 8).every((q) => q.startsWith('CREATE INDEX IF NOT EXISTS idx_query_history_'))).toBe(true)
      // Settings are still seeded after the upgrade
      expect(sqls.at(-1)).toMatch(/^INSERT OR IGNORE INTO settings/)
    })

    it('rebuilds a nullable history table whose refs lack ON DELETE SET NULL', async () => {
      const { db, calls } = fakeD1((sql) => {
        if (sql.startsWith('PRAGMA table_info')) return tableInfo(0)
        if (sql.startsWith('PRAGMA foreign_key_list')) return foreignKeys('NO ACTION')
        return null
      })
      const res = await callWorker(fakeEnv({ DB: db }), '/api/setup', postJson({ secret: 'test-setup-secret' }))
      expect(await res.json()).toMatchObject({ ok: true, upgraded: [expect.stringContaining('ON DELETE SET NULL')] })
      expect(calls.some((c) => c.sql === 'ALTER TABLE query_history_new RENAME TO query_history')).toBe(true)
    })

    it('leaves an up-to-date history table alone', async () => {
      const { db, calls } = fakeD1((sql) => {
        if (sql.startsWith('PRAGMA table_info')) return tableInfo(0)
        if (sql.startsWith('PRAGMA foreign_key_list')) return foreignKeys('SET NULL')
        return null
      })
      const res = await callWorker(fakeEnv({ DB: db }), '/api/setup', postJson({ secret: 'test-setup-secret' }))
      expect(await res.json()).not.toHaveProperty('upgraded')
      expect(calls.some((c) => c.sql.includes('query_history_new'))).toBe(false)
    })

    it('respects TABLE_PREFIX', async () => {
      const { db, calls } = fakeD1((sql) =>
        sql.startsWith('PRAGMA table_info(kp_query_history)') ? tableInfo(1) : null
      )
      const res = await callWorker(
        fakeEnv({ DB: db, TABLE_PREFIX: 'kp' }),
        '/api/setup',
        postJson({ secret: 'test-setup-secret' })
      )
      expect(res.status).toBe(200)
      const sqls = calls.map((c) => c.sql.replace(/\s+/g, ' '))
      expect(sqls).toContain('ALTER TABLE kp_query_history_new RENAME TO kp_query_history')
      expect(sqls.find((q) => q.startsWith('CREATE TABLE IF NOT EXISTS kp_query_history_new'))).toContain(
        'REFERENCES kp_users(id)'
      )
    })
  })

  describe('d1_databases cf_database_id upgrade', () => {
    // Every table is up-to-date except d1_databases, which predates the cf_database_id column.
    const upToDate = [
      { name: 'id', notnull: 0 },
      { name: 'user_id', notnull: 0 },
      { name: 'database_id', notnull: 0 },
      { name: 'notebook_run_limit', notnull: 0 },
      { name: 'last_run_seq', notnull: 1 },
      { name: 'seq', notnull: 0 },
      { name: 'cf_database_id', notnull: 0 },
    ]

    it('adds cf_database_id when it is missing', async () => {
      const { db, calls } = fakeD1((sql) => {
        if (!sql.startsWith('PRAGMA table_info')) return null
        return sql.includes('d1_databases')
          ? [
              { name: 'id', notnull: 0 },
              { name: 'binding_name', notnull: 1 },
            ]
          : upToDate
      })
      const res = await callWorker(fakeEnv({ DB: db }), '/api/setup', postJson({ secret: 'test-setup-secret' }))
      expect(res.status).toBe(200)
      expect(await res.json()).toMatchObject({ ok: true, upgraded: [expect.stringContaining('cf_database_id')] })
      expect(calls.some((c) => c.sql === 'ALTER TABLE d1_databases ADD COLUMN cf_database_id TEXT')).toBe(true)
    })

    it('leaves an up-to-date d1_databases table alone', async () => {
      const { db, calls } = fakeD1((sql) => (sql.startsWith('PRAGMA table_info') ? upToDate : null))
      const res = await callWorker(fakeEnv({ DB: db }), '/api/setup', postJson({ secret: 'test-setup-secret' }))
      expect(await res.json()).toMatchObject({ ok: true })
      expect(calls.some((c) => c.sql.includes('ADD COLUMN cf_database_id'))).toBe(false)
    })

    it('respects TABLE_PREFIX', async () => {
      const { db, calls } = fakeD1((sql) => {
        if (!sql.startsWith('PRAGMA table_info')) return null
        return sql.includes('kp_d1_databases') ? [{ name: 'id', notnull: 0 }] : upToDate
      })
      const res = await callWorker(
        fakeEnv({ DB: db, TABLE_PREFIX: 'kp' }),
        '/api/setup',
        postJson({ secret: 'test-setup-secret' })
      )
      expect(res.status).toBe(200)
      expect(calls.some((c) => c.sql === 'ALTER TABLE kp_d1_databases ADD COLUMN cf_database_id TEXT')).toBe(true)
    })
  })
})
