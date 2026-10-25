import { describe, expect, it } from 'vitest'
import { callWorker, fakeD1, fakeEnv, postJson } from './fakes'

describe('setup endpoint', () => {
  it('initialises the schema via POST with the secret in the body', async () => {
    const { db, calls } = fakeD1()
    const res = await callWorker(fakeEnv({ DB: db }), '/api/setup', postJson({ secret: 'test-setup-secret' }))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      ok: true,
      migrations: [{ name: 'schema_v1', status: 'applied' }],
      upgraded: ['schema_v1: applied'],
    })
    expect(calls.some((c) => c.sql.includes('CREATE TABLE IF NOT EXISTS users'))).toBe(true)
    expect(calls.some((c) => c.sql.includes('INSERT OR IGNORE INTO settings'))).toBe(true)
    expect(calls.some((c) => c.sql.includes('CREATE TABLE IF NOT EXISTS rate_limits'))).toBe(true)
    // The applied migration is recorded in the ledger table
    expect(calls.some((c) => c.sql.includes('CREATE TABLE IF NOT EXISTS _schema_migrations'))).toBe(true)
    expect(
      calls.some((c) => c.sql === 'INSERT INTO _schema_migrations (name) VALUES (?1)' && c.args[0] === 'schema_v1')
    ).toBe(true)
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
    // The ledger follows the effective prefix
    expect(calls.some((c) => c.sql === 'INSERT INTO _zeta_schema_migrations (name) VALUES (?1)')).toBe(true)
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
})
