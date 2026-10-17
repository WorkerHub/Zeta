import type { Env } from '../types'
import { encryptTotpSecret, decryptTotpSecret } from './totp'
import { now, tables } from './db'

const PREFIX = 'enc:v1:'

export const isEncryptedSecret = (v: string): boolean => v.startsWith(PREFIX)

// Idempotent: already-encrypted values are returned unchanged.
export async function sealSecret(env: Env, plaintext: string): Promise<string> {
  if (!plaintext || isEncryptedSecret(plaintext)) return plaintext
  return PREFIX + (await encryptTotpSecret(env, plaintext))
}

// Values without the prefix are legacy plaintext and are returned as-is.
export async function openSecret(env: Env, stored: string): Promise<string> {
  if (!isEncryptedSecret(stored)) return stored
  return decryptTotpSecret(env, stored.slice(PREFIX.length))
}

// Re-saves a settings JSON blob whose secret field is still legacy plaintext, encrypted, so
// deployments upgraded from older versions stop keeping it in the clear without waiting for an
// admin to re-save settings. The UPDATE only applies if the stored blob is still `raw`, so a
// concurrent settings save is never overwritten.
export async function sealLegacySecret(env: Env, key: string, raw: string, field: string): Promise<boolean> {
  let config: Record<string, unknown>
  try {
    config = JSON.parse(raw)
  } catch {
    return false
  }
  const value = config?.[field]
  if (typeof value !== 'string' || !value || isEncryptedSecret(value)) return false
  const sealed = JSON.stringify({ ...config, [field]: await sealSecret(env, value) })
  const T = tables(env)
  await env.DB.prepare(`UPDATE ${T.settings} SET value = ?1, updated_at = ?2 WHERE key = ?3 AND value = ?4`)
    .bind(sealed, now(), key, raw)
    .run()
  return true
}
