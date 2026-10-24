import { describe, it, expect } from 'vitest'
import { sealSecret, openSecret, isEncryptedSecret, sealLegacySecret } from '../secrets'
import type { Env } from '../../types'
import { fakeD1 } from '../../routes/__tests__/fakes'

// An explicitly-unprefixed deployment (TABLE_PREFIX set to the empty string): the SQL this test
// asserts on is generated for that state.
const env = { ENCRYPTION_KEY: 'ab'.repeat(32), TABLE_PREFIX: '' } as Env

describe('secrets', () => {
  it('round-trips and does not store plaintext', async () => {
    const sealed = await sealSecret(env, 'hunter2')
    expect(isEncryptedSecret(sealed)).toBe(true)
    expect(sealed).not.toContain('hunter2')
    expect(await openSecret(env, sealed)).toBe('hunter2')
  })
  it('is idempotent on already-sealed values', async () => {
    const sealed = await sealSecret(env, 'x')
    expect(await sealSecret(env, sealed)).toBe(sealed)
  })
  it('passes legacy plaintext through openSecret', async () => {
    expect(await openSecret(env, 'legacy-plain')).toBe('legacy-plain')
  })
  it('leaves empty values empty', async () => {
    expect(await sealSecret(env, '')).toBe('')
  })
  it('uses a fresh IV each time', async () => {
    expect(await sealSecret(env, 'same')).not.toBe(await sealSecret(env, 'same'))
  })
})

describe('sealLegacySecret', () => {
  it('re-saves a plaintext secret encrypted, guarded on the old value', async () => {
    const { db, calls } = fakeD1()
    const raw = JSON.stringify({ host: 'smtp.example.com', password: 'hunter2' })
    expect(await sealLegacySecret({ ...env, DB: db }, 'smtp_config', raw, 'password')).toBe(true)

    expect(calls).toHaveLength(1)
    const { sql, args } = calls[0]!
    expect(sql).toMatch(/^UPDATE settings SET value = \?1, updated_at = \?2 WHERE key = \?3 AND value = \?4$/)
    expect(args[2]).toBe('smtp_config')
    expect(args[3]).toBe(raw)
    const saved = JSON.parse(args[0] as string)
    expect(saved.host).toBe('smtp.example.com')
    expect(isEncryptedSecret(saved.password)).toBe(true)
    expect(await openSecret(env, saved.password)).toBe('hunter2')
  })

  it('leaves encrypted, empty, missing and malformed values alone', async () => {
    const { db, calls } = fakeD1()
    const e = { ...env, DB: db }
    const sealed = await sealSecret(env, 'k')
    expect(await sealLegacySecret(e, 'resend_config', JSON.stringify({ api_key: sealed }), 'api_key')).toBe(false)
    expect(await sealLegacySecret(e, 'resend_config', JSON.stringify({ api_key: '' }), 'api_key')).toBe(false)
    expect(await sealLegacySecret(e, 'resend_config', JSON.stringify({ from: 'x' }), 'api_key')).toBe(false)
    expect(await sealLegacySecret(e, 'resend_config', 'not json', 'api_key')).toBe(false)
    expect(await sealLegacySecret(e, 'resend_config', 'null', 'api_key')).toBe(false)
    expect(calls).toHaveLength(0)
  })
})
