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
})
