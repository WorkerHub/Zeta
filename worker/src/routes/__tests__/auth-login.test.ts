import { describe, it, expect, beforeAll } from 'vitest'
import { hashPassword, verifyPending2faToken, createPending2faToken } from '../../lib/auth'
import type { UserRow } from '../../types'
import { callWorker, fakeD1, fakeEnv, postJson } from './fakes'

const PASSWORD = 'correct horse battery'
let user: UserRow

beforeAll(async () => {
  user = {
    id: 'user-123', email: 'a@example.com', password_hash: await hashPassword(PASSWORD), name: 'A',
    role: 'member', email_verified: 1, two_factor_required: 0, created_at: 0, updated_at: 0,
  }
})

function loginEnv(opts: { has2fa: boolean }) {
  const { db } = fakeD1((sql) => {
    if (sql.startsWith('SELECT * FROM users') || sql.startsWith('SELECT email FROM users')) return user
    if (sql.includes('FROM totp_credentials')) return opts.has2fa ? { 1: 1 } : null
    return null
  })
  return fakeEnv({ DB: db })
}

describe('POST /api/auth/login', () => {
  it('returns only the pending token when 2FA is required, not the user id', async () => {
    const env = loginEnv({ has2fa: true })
    const res = await callWorker(env, '/api/auth/login', postJson({ email: user.email, password: PASSWORD }))
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(Object.keys(body).sort()).toEqual(['pendingToken', 'requires2fa'])
    expect(JSON.stringify(body)).not.toContain(user.id)
    // The id still reaches the 2FA step through the signed token
    const pending = await verifyPending2faToken(body.pendingToken as string, env.JWT_SECRET)
    expect(pending?.sub).toBe(user.id)
  })

  it('logs straight in when no 2FA is configured', async () => {
    const res = await callWorker(loginEnv({ has2fa: false }), '/api/auth/login',
      postJson({ email: user.email, password: PASSWORD }))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ accessToken: expect.any(String), user: { id: user.id } })
  })

  it('rejects a wrong password', async () => {
    const res = await callWorker(loginEnv({ has2fa: true }), '/api/auth/login',
      postJson({ email: user.email, password: 'nope' }))
    expect(res.status).toBe(401)
  })
})

describe('login rate limiting', () => {
  it('counts a parallel burst of guesses in full instead of letting it race past the limit', async () => {
    const env = loginEnv({ has2fa: false })
    const responses = await Promise.all(Array.from({ length: 15 }, () =>
      callWorker(env, '/api/auth/login', postJson({ email: user.email, password: 'wrong' }))))
    const statuses = responses.map((r) => r.status)
    expect(statuses.filter((s) => s === 401)).toHaveLength(10)
    expect(statuses.filter((s) => s === 429)).toHaveLength(5)
    // The right password is locked out too until the window ends
    const res = await callWorker(env, '/api/auth/login', postJson({ email: user.email, password: PASSWORD }))
    expect(res.status).toBe(429)
  })

  it('a successful login resets the account counter', async () => {
    const env = loginEnv({ has2fa: false })
    for (let i = 0; i < 9; i++) {
      await callWorker(env, '/api/auth/login', postJson({ email: user.email, password: 'wrong' }))
    }
    expect((await callWorker(env, '/api/auth/login', postJson({ email: user.email, password: PASSWORD }))).status).toBe(200)
    for (let i = 0; i < 9; i++) {
      const res = await callWorker(env, '/api/auth/login', postJson({ email: user.email, password: 'wrong' }))
      expect(res.status).toBe(401)
    }
  })
})

describe('refresh cookie', () => {
  const cookieOf = (res: Response) => res.headers.get('Set-Cookie') ?? ''

  it('is Secure when the request arrived over https, even if APP_URL says http', async () => {
    const env = loginEnv({ has2fa: false })
    const res = await callWorker(env, 'https://zeta.example.com/api/auth/login',
      postJson({ email: user.email, password: PASSWORD }))
    expect(res.status).toBe(200)
    expect(cookieOf(res)).toMatch(/^refresh_token=.+; Secure/)
  })

  it('is Secure when APP_URL is https', async () => {
    const env = { ...loginEnv({ has2fa: false }), APP_URL: 'https://zeta.example.com' }
    const res = await callWorker(env, '/api/auth/login', postJson({ email: user.email, password: PASSWORD }))
    expect(cookieOf(res)).toContain('; Secure')
  })

  it('stays usable over plain http in local development', async () => {
    const res = await callWorker(loginEnv({ has2fa: false }), '/api/auth/login',
      postJson({ email: user.email, password: PASSWORD }))
    expect(cookieOf(res)).not.toContain('Secure')
  })
})

describe('POST /api/auth/2fa/email-otp/send', () => {
  it('limits how often one account can trigger OTP emails', async () => {
    const env = loginEnv({ has2fa: true })
    const pendingToken = await createPending2faToken(user.id, env.JWT_SECRET)
    const statuses: number[] = []
    for (let i = 0; i < 4; i++) {
      statuses.push((await callWorker(env, '/api/auth/2fa/email-otp/send', postJson({ pendingToken }))).status)
    }
    // No email provider in tests, so allowed sends fail with 500; the 4th is rate-limited
    expect(statuses).toEqual([500, 500, 500, 429])
  })
})
