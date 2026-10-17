import { describe, it, expect, beforeAll } from 'vitest'
import { hashPassword, verifyPending2faToken } from '../../lib/auth'
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
    if (sql.startsWith('SELECT * FROM users')) return user
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
