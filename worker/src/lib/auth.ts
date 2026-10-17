import type { Env } from '../types'
import { KV } from './kv'
import { tables } from './db'

// ── Password (PBKDF2 via WebCrypto) ─────────────────────────────────────────

const PBKDF2_ITERATIONS = 100_000
const SALT_LEN = 32

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_LEN))
  const keyMaterial = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']
  )
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: PBKDF2_ITERATIONS },
    keyMaterial, 256
  )
  const saltHex = bufToHex(salt)
  const hashHex = bufToHex(new Uint8Array(bits))
  return `pbkdf2:${PBKDF2_ITERATIONS}:${saltHex}:${hashHex}`
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split(':')
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false
  const [, iterStr, saltHex, hashHex] = parts
  const iterations = parseInt(iterStr ?? '0', 10)
  if (isNaN(iterations) || iterations <= 0 || iterations > 600_000) return false
  const salt = hexToBuf(saltHex ?? '')
  const expected = hexToBuf(hashHex ?? '')
  const keyMaterial = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']
  )
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    keyMaterial, 256
  )
  // Constant-time compare
  const derived = new Uint8Array(bits)
  if (derived.length !== expected.length) return false
  let diff = 0
  for (let i = 0; i < derived.length; i++) diff |= (derived[i] ?? 0) ^ (expected[i] ?? 0)
  return diff === 0
}

// ── JWT (HS256) ──────────────────────────────────────────────────────────────

export interface AccessTokenPayload {
  sub: string
  role: 'admin' | 'member'
  jti: string
  iat: number
  exp: number
  type: 'access'
}

export interface RefreshTokenPayload {
  sub: string
  jti: string
  iat: number
  exp: number
  type: 'refresh'
}

export interface Pending2faTokenPayload {
  sub: string
  jti: string
  iat: number
  exp: number
  type: 'pending_2fa'
}

const ACCESS_TTL = 15 * 60         // 15 min
const REFRESH_TTL = 7 * 24 * 3600  // 7 days
const PENDING_TTL = 10 * 60        // 10 min

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']
  )
}

function b64url(buf: ArrayBuffer | Uint8Array): string {
  const arr = buf instanceof Uint8Array ? buf : new Uint8Array(buf)
  let binary = ''
  for (let i = 0; i < arr.length; i++) binary += String.fromCharCode(arr[i]!)
  return btoa(binary)
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}

function b64urlDecode(s: string): Uint8Array {
  const padded = s.replace(/-/g, '+').replace(/_/g, '/').padEnd(s.length + (4 - s.length % 4) % 4, '=')
  const bin = atob(padded)
  return Uint8Array.from(bin, (c) => c.charCodeAt(0))
}

async function signJwt(payload: Record<string, unknown>, secret: string): Promise<string> {
  const header = b64url(new TextEncoder().encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })))
  const body = b64url(new TextEncoder().encode(JSON.stringify(payload)))
  const key = await hmacKey(secret)
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${header}.${body}`))
  return `${header}.${body}.${b64url(sig)}`
}

async function verifyJwt<T>(token: string, secret: string): Promise<T | null> {
  const parts = token.split('.')
  if (parts.length !== 3) return null
  const [header, body, sig] = parts as [string, string, string]
  try {
    const headerObj = JSON.parse(new TextDecoder().decode(b64urlDecode(header))) as { alg?: string }
    if (headerObj.alg !== 'HS256') return null
  } catch { return null }
  const key = await hmacKey(secret)
  const valid = await crypto.subtle.verify(
    'HMAC', key,
    b64urlDecode(sig),
    new TextEncoder().encode(`${header}.${body}`)
  )
  if (!valid) return null
  const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(body))) as T & { exp?: number }
  if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null
  return payload
}

export async function createAccessToken(
  userId: string, role: 'admin' | 'member', secret: string
): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  return signJwt({
    sub: userId, role, jti: crypto.randomUUID(),
    iat: now, exp: now + ACCESS_TTL, type: 'access'
  }, secret)
}

export async function createRefreshToken(userId: string, secret: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  return signJwt({
    sub: userId, jti: crypto.randomUUID(),
    iat: now, exp: now + REFRESH_TTL, type: 'refresh'
  }, secret)
}

export async function createPending2faToken(userId: string, secret: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  return signJwt({
    sub: userId, jti: crypto.randomUUID(), iat: now, exp: now + PENDING_TTL, type: 'pending_2fa'
  }, secret)
}

export async function verifyAccessToken(
  token: string | undefined, secret: string
): Promise<AccessTokenPayload | null> {
  if (!token) return null
  const payload = await verifyJwt<AccessTokenPayload>(token, secret)
  if (!payload || payload.type !== 'access') return null
  return payload
}

export async function verifyRefreshToken(
  token: string | undefined, secret: string
): Promise<RefreshTokenPayload | null> {
  if (!token) return null
  const payload = await verifyJwt<RefreshTokenPayload>(token, secret)
  if (!payload || payload.type !== 'refresh') return null
  return payload
}

export async function verifyPending2faToken(
  token: string | undefined, secret: string
): Promise<Pending2faTokenPayload | null> {
  if (!token) return null
  const payload = await verifyJwt<Pending2faTokenPayload>(token, secret)
  if (!payload || payload.type !== 'pending_2fa') return null
  return payload
}

export async function revokeRefreshToken(env: Env, jti: string): Promise<void> {
  await env.KV.put(KV.jtiDeny(jti), '1', { expirationTtl: REFRESH_TTL })
}

export async function isRefreshTokenRevoked(env: Env, jti: string): Promise<boolean> {
  return (await env.KV.get(KV.jtiDeny(jti))) !== null
}

// ── Rate limiting ─────────────────────────────────────────────────────────────

// Counters live in the D1 rate_limits table: each hit is a single upsert, and D1 runs every
// statement on one primary, so concurrent requests can no longer all read the same count and
// slip past the limit (KV's read-then-write could, and KV reads are only eventually
// consistent). Fixed window: the first hit after expiry starts a new one.
//
// Deployments that have not re-run POST /api/setup (or applied migration 0003) yet lack the
// table; they fall back to the old, approximate KV counters instead of failing every login.
// Any other D1 error is rethrown: falling back on outages would hide them and split one key's
// count across two stores.

let warnedKvFallback = false

// Returns normally only for a missing rate_limits table (D1: "no such table: <prefix>rate_limits").
function kvFallback(err: unknown): void {
  if (!/no such table: \w*rate_limits\b/.test(err instanceof Error ? err.message : String(err))) throw err
  if (warnedKvFallback) return
  warnedKvFallback = true
  console.warn('rate_limits table missing, using approximate KV counters. Re-run POST /api/setup.')
}

// Records one hit against `key` and returns the count in the current window, this hit included.
async function hitCounter(env: Env, key: string, ttl: number): Promise<number> {
  const ts = Math.floor(Date.now() / 1000)
  try {
    const T = tables(env)
    const row = await env.DB.prepare(
      `INSERT INTO ${T.rate_limits} (key, count, expires_at) VALUES (?1, 1, ?2)
       ON CONFLICT(key) DO UPDATE SET
         count = CASE WHEN expires_at <= ?3 THEN 1 ELSE count + 1 END,
         expires_at = CASE WHEN expires_at <= ?3 THEN ?2 ELSE expires_at END
       RETURNING count`
    ).bind(key, ts + ttl, ts).first<{ count: number }>()
    if (!row) throw new Error('rate_limits upsert returned no row')
    // Expired rows are otherwise only reset on their next hit; sweep them now and then.
    if (Math.random() < 0.01) {
      await env.DB.prepare(`DELETE FROM ${T.rate_limits} WHERE expires_at <= ?1`).bind(ts).run()
    }
    return row.count
  } catch (err) {
    kvFallback(err)
    const count = parseInt((await env.KV.get(key)) ?? '0', 10) + 1
    await env.KV.put(key, String(count), { expirationTtl: ttl })
    return count
  }
}

// Takes back one hit, e.g. a login attempt that turned out to use the right password.
async function undoHit(env: Env, key: string, ttl: number): Promise<void> {
  try {
    const T = tables(env)
    await env.DB.prepare(`UPDATE ${T.rate_limits} SET count = MAX(count - 1, 0) WHERE key = ?1`).bind(key).run()
  } catch (err) {
    kvFallback(err)
    const count = parseInt((await env.KV.get(key)) ?? '0', 10)
    if (count > 0) await env.KV.put(key, String(count - 1), { expirationTtl: ttl })
  }
}

async function clearCounter(env: Env, key: string): Promise<void> {
  try {
    const T = tables(env)
    await env.DB.prepare(`DELETE FROM ${T.rate_limits} WHERE key = ?1`).bind(key).run()
  } catch (err) {
    kvFallback(err)
    await env.KV.delete(key)
  }
}

// Counts one attempt and returns false once more than `limit` were made in the window.
export async function checkRateLimit(env: Env, key: string, limit: number, ttl: number): Promise<boolean> {
  return (await hitCounter(env, key, ttl)) <= limit
}

const LOGIN_WINDOW = 15 * 60

// Reserves an attempt against both the IP and the targeted account *before* the password is
// checked, so a burst of parallel guesses is counted in full. Returns false when either limit is
// exceeded. Callers must call loginAttemptSucceeded() once the password turns out to be right.
export async function beginLoginAttempt(env: Env, ip: string, email: string): Promise<boolean> {
  const [byIp, byAccount] = await Promise.all([
    hitCounter(env, KV.loginAttempts(ip), LOGIN_WINDOW),
    hitCounter(env, KV.loginAttempts(`acct:${email}`), LOGIN_WINDOW),
  ])
  return byIp <= 20 && byAccount <= 10
}

// Clears the account counter and gives the IP its reserved attempt back: only failures count
// against an IP, and a successful login must not wipe the IP's failure history either.
export async function loginAttemptSucceeded(env: Env, ip: string, email: string): Promise<void> {
  await Promise.all([
    undoHit(env, KV.loginAttempts(ip), LOGIN_WINDOW),
    clearCounter(env, KV.loginAttempts(`acct:${email}`)),
  ])
}

export async function check2faRateLimit(env: Env, userId: string): Promise<boolean> {
  return checkRateLimit(env, KV.twoFactorAttempts(userId), 5, 10 * 60)
}

export async function reset2faAttempts(env: Env, userId: string): Promise<void> {
  await clearCounter(env, KV.twoFactorAttempts(userId))
}

export async function checkEmailRateLimit(env: Env, ip: string): Promise<boolean> {
  return checkRateLimit(env, KV.emailAttempts(ip), 3, 15 * 60)
}

export async function checkRegisterRateLimit(env: Env, ip: string): Promise<boolean> {
  return checkRateLimit(env, KV.registerAttempts(ip), 5, 15 * 60)
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function bufToHex(buf: Uint8Array): string {
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('')
}

function hexToBuf(hex: string): Uint8Array {
  const len = hex.length / 2
  const arr = new Uint8Array(len)
  for (let i = 0; i < len; i++) arr[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return arr
}
