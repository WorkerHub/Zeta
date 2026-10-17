import { describe, it, expect } from 'vitest'
import { resolveQueryBinding } from '../bindings'
import type { Env } from '../../types'

const d1 = { prepare: () => ({}) }
const env = {
  DB: d1, KV: {}, ASSETS: {}, JWT_SECRET: 'jwt', ENCRYPTION_KEY: 'k', SETUP_SECRET: 's', APP_URL: 'u',
  QUERY_DB_1: d1, ANALYTICS: d1,
} as unknown as Env

describe('resolveQueryBinding', () => {
  it('resolves registered D1 bindings', () => {
    for (const name of ['QUERY_DB_1', 'ANALYTICS']) {
      const r = resolveQueryBinding(env, name)
      expect(r.ok && r.db).toBe(d1)
    }
  })

  it('never resolves the management bindings, even though DB is a real D1 database', () => {
    for (const name of ['DB', 'KV', 'ASSETS']) {
      const r = resolveQueryBinding(env, name)
      expect(r.ok).toBe(false)
      expect(!r.ok && r.error).toMatch(/reserved/)
    }
  })

  it('rejects secrets, vars and object internals with the same message as a missing binding', () => {
    const missing = resolveQueryBinding(env, 'QUERY_DB_9')
    for (const name of ['JWT_SECRET', 'SETUP_SECRET', 'constructor', 'hasOwnProperty']) {
      const r = resolveQueryBinding(env, name)
      expect(r.ok).toBe(false)
      expect(!r.ok && r.error).toBe(!missing.ok && missing.error.replace('QUERY_DB_9', name))
    }
  })

  it('rejects malformed names', () => {
    for (const name of ['', '__proto__ x', '1DB', 'a-b', 'x'.repeat(65), undefined, 42]) {
      const r = resolveQueryBinding(env, name)
      expect(r.ok).toBe(false)
    }
  })
})
