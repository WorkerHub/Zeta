import { TOTP } from 'otpauth'
import type { Env } from '../types'

// ── Encryption helpers (AES-GCM via WebCrypto) ────────────────────────────────

async function getDerivedKey(env: Env): Promise<CryptoKey> {
  const raw = hexToBuf(env.ENCRYPTION_KEY)
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt'])
}

async function encrypt(key: CryptoKey, plaintext: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(plaintext)
  )
  const combined = new Uint8Array(iv.byteLength + ct.byteLength)
  combined.set(iv)
  combined.set(new Uint8Array(ct), iv.byteLength)
  return bufToBase64(combined)
}

async function decrypt(key: CryptoKey, ciphertext: string): Promise<string> {
  const combined = base64ToBuf(ciphertext)
  const iv = combined.slice(0, 12)
  const ct = combined.slice(12)
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct)
  return new TextDecoder().decode(plain)
}

// ── TOTP helpers ──────────────────────────────────────────────────────────────

export function generateTotpSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(20))
  // Base32 encode
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  let result = ''
  let bits = 0
  let value = 0
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      result += alphabet[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) result += alphabet[(value << (5 - bits)) & 31]
  return result
}

export async function encryptTotpSecret(env: Env, secret: string): Promise<string> {
  const key = await getDerivedKey(env)
  return encrypt(key, secret)
}

export async function decryptTotpSecret(env: Env, encrypted: string): Promise<string> {
  const key = await getDerivedKey(env)
  return decrypt(key, encrypted)
}

export function getTotpUri(secret: string, email: string, appName: string): string {
  const totp = new TOTP({ issuer: appName, label: email, secret, digits: 6, period: 30 })
  return totp.toString()
}

export function verifyTotpCode(secret: string, code: string): boolean {
  const totp = new TOTP({ secret, digits: 6, period: 30 })
  const delta = totp.validate({ token: code, window: 1 })
  return delta !== null
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function bufToBase64(buf: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < buf.length; i++) binary += String.fromCharCode(buf[i]!)
  return btoa(binary)
}

function base64ToBuf(b64: string): Uint8Array {
  const bin = atob(b64)
  return Uint8Array.from(bin, (c) => c.charCodeAt(0))
}

function hexToBuf(hex: string): Uint8Array {
  const len = hex.length / 2
  const arr = new Uint8Array(len)
  for (let i = 0; i < len; i++) arr[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return arr
}
