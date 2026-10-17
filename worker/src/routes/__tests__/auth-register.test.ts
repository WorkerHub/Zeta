import { describe, it, expect } from 'vitest'
import { callWorker, fakeD1, fakeEnv, postJson } from './fakes'

function registerEnv(opts: { registration: string | null; hasUsers: boolean }) {
  const { db, calls } = fakeD1((sql, args) => {
    if (sql.startsWith('SELECT value FROM settings')) {
      if (args[0] === 'registration_enabled') return opts.registration === null ? null : { value: opts.registration }
      if (args[0] === 'require_email_verification') return { value: 'false' }
      return null
    }
    if (sql === 'SELECT 1 FROM users LIMIT 1') return opts.hasUsers ? { 1: 1 } : null
    return null
  })
  return { env: fakeEnv({ DB: db }), calls }
}

const signup = { email: 'new@example.com', password: 'long enough', name: 'New' }
const inserted = (calls: { sql: string }[]) => calls.some((c) => c.sql.startsWith('INSERT INTO users'))

describe('POST /api/auth/register', () => {
  it('lets the first account register even though registration is closed by default', async () => {
    const { env, calls } = registerEnv({ registration: 'false', hasUsers: false })
    const res = await callWorker(env, '/api/auth/register', postJson(signup))
    expect(res.status).toBe(201)
    expect(inserted(calls)).toBe(true)
  })

  it('refuses everyone else while registration is closed', async () => {
    const { env, calls } = registerEnv({ registration: 'false', hasUsers: true })
    const res = await callWorker(env, '/api/auth/register', postJson(signup))
    expect(res.status).toBe(403)
    expect(inserted(calls)).toBe(false)
  })

  it('allows registration once an admin opened it', async () => {
    const { env, calls } = registerEnv({ registration: 'true', hasUsers: true })
    expect((await callWorker(env, '/api/auth/register', postJson(signup))).status).toBe(201)
    expect(inserted(calls)).toBe(true)
  })
})
