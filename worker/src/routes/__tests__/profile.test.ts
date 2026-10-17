import { describe, it, expect, beforeAll } from 'vitest'
import { hashPassword } from '../../lib/auth'
import { bearer, callWorker, fakeD1, fakeEnv, postJson } from './fakes'

const PASSWORD = 'correct horse battery'
let passwordHash: string

beforeAll(async () => { passwordHash = await hashPassword(PASSWORD) })

function profileEnv() {
  const { db, calls } = fakeD1((sql) =>
    sql.startsWith('SELECT email, password_hash FROM users') ? { email: 'a@example.com', password_hash: passwordHash } : null)
  return { env: fakeEnv({ DB: db }), calls }
}

const del = (body?: unknown): RequestInit => postJson(body, { method: 'DELETE' })

describe.each([
  ['TOTP authenticator', '/api/profile/totp/cred-1', 'DELETE FROM totp_credentials'],
  ['passkey', '/api/profile/passkey/cred-1', 'DELETE FROM passkey_credentials'],
])('removing a %s', (_, path, deleteSql) => {
  const deleted = (calls: { sql: string }[]) => calls.some((c) => c.sql.startsWith(deleteSql))

  it('needs the current password, not just an access token', async () => {
    const { env, calls } = profileEnv()
    const headers = await bearer(env, 'u1')
    expect((await callWorker(env, path, { method: 'DELETE', headers })).status).toBe(400)
    expect((await callWorker(env, path, { ...del({ currentPassword: 'wrong' }), headers: { ...headers, 'Content-Type': 'application/json' } })).status).toBe(403)
    expect(deleted(calls)).toBe(false)
  })

  it('works with the current password', async () => {
    const { env, calls } = profileEnv()
    const headers = await bearer(env, 'u1')
    const res = await callWorker(env, path, { ...del({ currentPassword: PASSWORD }), headers: { ...headers, 'Content-Type': 'application/json' } })
    expect(res.status).toBe(200)
    expect(deleted(calls)).toBe(true)
    expect(calls.find((c) => c.sql.startsWith(deleteSql))!.args).toEqual(['cred-1', 'u1'])
  })

  it('rate-limits password guesses like the login form', async () => {
    const { env, calls } = profileEnv()
    const headers = { ...(await bearer(env, 'u1')), 'Content-Type': 'application/json' }
    const statuses: number[] = []
    for (let i = 0; i < 11; i++) {
      statuses.push((await callWorker(env, path, { ...del({ currentPassword: `guess-${i}` }), headers })).status)
    }
    expect(statuses.slice(0, 10).every((s) => s === 403)).toBe(true)
    expect(statuses[10]).toBe(429)
    expect(deleted(calls)).toBe(false)
  })
})

describe('POST /api/profile/change-password', () => {
  it('rejects a wrong current password and accepts the right one', async () => {
    const { env, calls } = profileEnv()
    const headers = await bearer(env, 'u1')
    const wrong = await callWorker(env, '/api/profile/change-password',
      postJson({ currentPassword: 'wrong', newPassword: 'new password' }, { headers }))
    expect(wrong.status).toBe(403)
    const ok = await callWorker(env, '/api/profile/change-password',
      postJson({ currentPassword: PASSWORD, newPassword: 'new password' }, { headers }))
    expect(ok.status).toBe(200)
    expect(calls.filter((c) => c.sql.startsWith('UPDATE users SET password_hash'))).toHaveLength(1)
  })
})
