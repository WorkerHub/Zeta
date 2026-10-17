import { describe, it, expect } from 'vitest'
import { KV } from '../../lib/kv'
import { bearer, callWorker, fakeD1, fakeEnv } from './fakes'

describe('CORS', () => {
  const env = () => fakeEnv({ APP_URL: 'https://zeta.example.com/' })
  const acao = async (origin?: string) => {
    const res = await callWorker(env(), '/api/health', origin ? { headers: { Origin: origin } } : undefined)
    return res.headers.get('Access-Control-Allow-Origin')
  }

  it('allows the configured APP_URL', async () => {
    expect(await acao('https://zeta.example.com')).toBe('https://zeta.example.com')
  })

  it('sends no allow-origin header for requests without an Origin', async () => {
    expect(await acao()).toBeNull()
  })

  it('rejects opaque ("null") and foreign origins', async () => {
    expect(await acao('null')).toBeNull()
    expect(await acao('https://evil.example.com')).toBeNull()
  })
})

describe('requireAuth', () => {
  const profileEnv = () => {
    const { db } = fakeD1((sql) => (sql.includes('FROM users WHERE id') ? { id: 'u1', email: 'a@example.com' } : null))
    return fakeEnv({ DB: db })
  }

  it('accepts a valid access token', async () => {
    const env = profileEnv()
    const res = await callWorker(env, '/api/profile/me', { headers: await bearer(env, 'u1') })
    expect(res.status).toBe(200)
  })

  it('rejects an access token issued before the sessions were invalidated', async () => {
    const env = profileEnv()
    const member = await bearer(env, 'u1')
    const admin = await bearer(env, 'u1', 'admin')
    // e.g. the password was changed or an admin demoted the user after the tokens were issued
    await env.KV.put(KV.sessionInvalidatedAt('u1'), String(Math.floor(Date.now() / 1000)))
    expect((await callWorker(env, '/api/profile/me', { headers: member })).status).toBe(401)
    expect((await callWorker(env, '/api/admin/users', { headers: admin })).status).toBe(401)
  })
})
