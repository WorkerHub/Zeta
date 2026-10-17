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
    expect(calls[0]!.sql.replace(/\s+/g, ' ')).toMatch(/^INSERT INTO kp_rate_limits .+ ON CONFLICT\(key\) DO UPDATE SET .+ RETURNING count$/)
  })

  it('falls back to KV counters when the rate_limits table does not exist yet', async () => {
    const { db } = fakeD1((sql) => {
      if (sql.includes('rate_limits')) throw new Error('no such table: rate_limits')
      return null
    }, { rateLimits: false })
    const env = fakeEnv({ DB: db })
    const results = []
    for (let i = 0; i < 4; i++) results.push(await checkRateLimit(env, 'k', 3, 60))
    expect(results).toEqual([true, true, true, false])
    expect(await env.KV.get('k')).toBe('4')
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
