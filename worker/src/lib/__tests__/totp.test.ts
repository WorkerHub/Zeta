import { describe, it, expect } from 'vitest'
import { encryptTotpSecret, decryptTotpSecret } from '../totp'
import type { Env } from '../../types'

describe('ENCRYPTION_KEY validation', () => {
  it('accepts a 64-character hex key', async () => {
    const env = { ENCRYPTION_KEY: 'aB'.repeat(32) } as Env
    expect(await decryptTotpSecret(env, await encryptTotpSecret(env, 'JBSWY3DPEHPK3PXP'))).toBe('JBSWY3DPEHPK3PXP')
  })

  it.each([
    ['empty', ''],
    ['missing', undefined],
    ['too short', 'ab'.repeat(16)],
    ['odd length', `${'ab'.repeat(31)}abc`],
    ['non-hex passphrase of the right length', 'x'.repeat(64)],
  ])('rejects a %s key instead of deriving a weak one', async (_, key) => {
    const env = { ENCRYPTION_KEY: key } as Env
    await expect(encryptTotpSecret(env, 'secret')).rejects.toThrow(/ENCRYPTION_KEY must be a 64-character hex string/)
  })
})
