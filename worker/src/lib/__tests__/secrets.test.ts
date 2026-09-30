import { describe, it, expect } from 'vitest'
import { sealSecret, openSecret, isEncryptedSecret } from '../secrets'
import type { Env } from '../../types'

const env = { ENCRYPTION_KEY: 'ab'.repeat(32) } as Env

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
