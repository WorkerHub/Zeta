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

  it('rejects a wrong secret without touching the database', async () => {
    const { db, calls } = fakeD1()
    for (const secret of ['wrong', 'test-setup-secre', 'test-setup-secret-and-more']) {
      const res = await callWorker(fakeEnv({ DB: db }), '/api/setup', postJson({ secret }))
      expect(res.status).toBe(403)
    }
    expect(calls).toHaveLength(0)
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
    expect(calls).toHaveLength(0)
  })

  describe('query_history upgrade', () => {
    const tableInfo = (notnull: number) => [
      { name: 'id', notnull: 0 },
      { name: 'user_id', notnull },
      { name: 'database_id', notnull },
      { name: 'sql', notnull: 1 },
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
})
