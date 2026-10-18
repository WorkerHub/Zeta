import { describe, it, expect } from 'vitest'
import { checkRateLimit, beginLoginAttempt, loginAttemptSucceeded } from '../auth'
import { KV } from '../kv'
import { fakeD1, fakeEnv } from '../../routes/__tests__/fakes'

describe('rate limiting', () => {
  it('counts every hit of a parallel burst, so no more than the limit gets through', async () => {
    const { db } = fakeD1()
    const env = fakeEnv({ DB: db })
    const results = await Promise.all(Array.from({ length: 12 }, () => checkRateLimit(env, 'k', 5, 60)))
    expect(results.filter(Boolean)).toHaveLength(5)
  })

  it('starts a new window once the old one expired', async () => {
    const { db, rateLimits } = fakeD1()
    const env = fakeEnv({ DB: db })
    for (let i = 0; i < 3; i++) await checkRateLimit(env, 'k', 2, 60)
    expect(await checkRateLimit(env, 'k', 2, 60)).toBe(false)
    rateLimits.get('k')!.expires_at = 0
    expect(await checkRateLimit(env, 'k', 2, 60)).toBe(true)
    expect(rateLimits.get('k')!.count).toBe(1)
  })

  it('uses a single atomic upsert on the prefixed table', async () => {
    const { db, calls } = fakeD1()
    await checkRateLimit(fakeEnv({ DB: db, TABLE_PREFIX: 'kp' }), 'k', 5, 60)
    expect(calls[0]!.sql.replace(/\s+/g, ' ')).toMatch(
      /^INSERT INTO kp_rate_limits .+ ON CONFLICT\(key\) DO UPDATE SET .+ RETURNING count, expires_at$/
    )
  })

  it('falls back to KV counters when the rate_limits table does not exist yet', async () => {
    const { db } = fakeD1(
      (sql) => {
        if (sql.includes('rate_limits')) throw new Error('no such table: rate_limits')
        return null
      },
      { rateLimits: false }
    )
    const env = fakeEnv({ DB: db })
    const results = []
    for (let i = 0; i < 4; i++) results.push(await checkRateLimit(env, 'k', 3, 60))
    expect(results).toEqual([true, true, true, false])
    expect(await env.KV.get('k')).toBe('4')
  })

  it('falls back for a prefixed missing table too', async () => {
    const { db } = fakeD1(
      (sql) => {
        if (sql.includes('rate_limits')) throw new Error('D1_ERROR: no such table: kp_rate_limits: SQLITE_ERROR')
        return null
      },
      { rateLimits: false }
    )
    expect(await checkRateLimit(fakeEnv({ DB: db, TABLE_PREFIX: 'kp' }), 'k', 3, 60)).toBe(true)
  })

  it('surfaces other D1 errors instead of silently switching to KV', async () => {
    const { db } = fakeD1(
      (sql) => {
        if (sql.includes('rate_limits')) throw new Error('D1_ERROR: Network connection lost.')
        return null
      },
      { rateLimits: false }
    )
    const env = fakeEnv({ DB: db })
    await expect(checkRateLimit(env, 'k', 3, 60)).rejects.toThrow('Network connection lost')
    expect(await env.KV.get('k')).toBeNull()
  })

  describe('login attempts', () => {
    const ip = '203.0.113.9'
    const email = 'a@example.com'

    it('blocks the account after 10 attempts and the IP after 20', async () => {
      const { db } = fakeD1()
      const env = fakeEnv({ DB: db })
      for (let i = 0; i < 10; i++) expect(await beginLoginAttempt(env, ip, email)).toBe(true)
      expect(await beginLoginAttempt(env, ip, email)).toBe(false)
      // Other accounts from the same IP are still allowed until the IP limit
      for (let i = 0; i < 9; i++) expect(await beginLoginAttempt(env, ip, `u${i}@example.com`)).toBe(true)
      expect(await beginLoginAttempt(env, ip, 'other@example.com')).toBe(false)
    })

    it('a successful login clears the account and gives the IP its attempt back', async () => {
      const { db, rateLimits } = fakeD1()
      const env = fakeEnv({ DB: db })
      await beginLoginAttempt(env, ip, email) // failure
      await beginLoginAttempt(env, ip, email) // success
      await loginAttemptSucceeded(env, ip, email)
      expect(rateLimits.get(KV.loginAttempts(ip))!.count).toBe(1)
      expect(rateLimits.has(KV.loginAttempts(`acct:${email}`))).toBe(false)
    })
  })
})
