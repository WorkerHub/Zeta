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

describe('CORS without APP_URL', () => {
  const env = () => fakeEnv({ APP_URL: undefined })
  const acao = async (origin: string, path = '/api/health', headers: Record<string, string> = {}) =>
    (await callWorker(env(), path, { headers: { Origin: origin, ...headers } })).headers.get(
      'Access-Control-Allow-Origin'
    )

  it('allows the request origin itself', async () => {
    expect(await acao('https://zeta.example.com', 'https://zeta.example.com/api/health')).toBe(
      'https://zeta.example.com'
    )
    expect(await acao('http://localhost:8787', '/api/health')).toBe('http://localhost:8787')
  })

  it('rejects a cross-origin caller', async () => {
    expect(await acao('https://evil.example.com', 'https://zeta.example.com/api/health')).toBeNull()
  })

  it('ignores X-Forwarded-Host when deriving the allowed origin', async () => {
    const forwarded = { 'X-Forwarded-Host': 'evil.example.com', 'X-Forwarded-Proto': 'https' }
    expect(await acao('https://evil.example.com', '/api/health', forwarded)).toBeNull()
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

describe('security headers', () => {
  it('sends HSTS when the request arrived over https, even if APP_URL says http', async () => {
    const env = fakeEnv({ APP_URL: 'http://zeta.example.com' })
    const res = await callWorker(env, 'https://zeta.example.com/api/health')
    expect(res.headers.get('Strict-Transport-Security')).toContain('max-age=')
  })

  it('omits HSTS for plain-http local development', async () => {
    const res = await callWorker(fakeEnv(), '/api/health')
    expect(res.headers.get('Strict-Transport-Security')).toBeNull()
  })

  it('covers the SPA too, with a CSP that allows the Google Fonts the page loads', async () => {
    const res = await callWorker(fakeEnv(), '/query')
    const csp = res.headers.get('Content-Security-Policy') ?? ''
    expect(csp).toContain("style-src 'self' 'unsafe-inline' https://fonts.googleapis.com")
    expect(csp).toContain("font-src 'self' https://fonts.gstatic.com")
    expect(csp).toContain("base-uri 'self'")
    expect(csp).toContain("form-action 'self'")
  })
})

describe('request body limit', () => {
  it('rejects oversized API bodies with a JSON 413 before any route parses them', async () => {
    const { db, calls } = fakeD1()
    const env = fakeEnv({ DB: db })
    const res = await callWorker(env, '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'a@example.com', password: 'x'.repeat(5 * 1024 * 1024) }),
    })
    expect(res.status).toBe(413)
    expect(await res.json()).toEqual({ error: 'Request body too large' })
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect(calls).toHaveLength(0)
  })

  it('lets a large but legitimate notebook save through', async () => {
    const { db } = fakeD1((sql) => (sql.startsWith('SELECT id FROM notebooks') ? { id: 'nb1' } : null))
    const env = fakeEnv({ DB: db })
    const res = await callWorker(env, '/api/notebooks/nb1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...(await bearer(env, 'u1')) },
      // 512K characters of 3-byte UTF-8 text: the largest notebook the API accepts
      body: JSON.stringify({ sql_content: '表'.repeat(512 * 1024) }),
    })
    expect(res.status).toBe(200)
  })
})
