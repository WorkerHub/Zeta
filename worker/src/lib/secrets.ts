import type { Env } from '../types'
import { encryptTotpSecret, decryptTotpSecret } from './totp'

const PREFIX = 'enc:v1:'

export const isEncryptedSecret = (v: string): boolean => v.startsWith(PREFIX)

// Idempotent: already-encrypted values are returned unchanged.
export async function sealSecret(env: Env, plaintext: string): Promise<string> {
  if (!plaintext || isEncryptedSecret(plaintext)) return plaintext
  return PREFIX + await encryptTotpSecret(env, plaintext)
}

// Values without the prefix are legacy plaintext and are returned as-is.
export async function openSecret(env: Env, stored: string): Promise<string> {
  if (!isEncryptedSecret(stored)) return stored
  return decryptTotpSecret(env, stored.slice(PREFIX.length))
}
