import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  createAccessToken,
  createRefreshToken,
  hashPassword,
  verifyAccessToken,
  verifyPassword,
  verifyRefreshToken,
} from '../auth'

const prod = { JWT_SECRET: 'shared-secret', APP_URL: 'https://zeta.example.com' }
const staging = { JWT_SECRET: 'shared-secret', APP_URL: 'https://staging.zeta.example.com' }

const b64url = (data: string | ArrayBuffer) =>
  btoa(typeof data === 'string' ? data : String.fromCharCode(...new Uint8Array(data)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '')

// Signs a token the way versions before iss/aud did: no registered claims besides iat/exp.
async function legacyToken(payload: Record<string, unknown>, secret: string): Promise<string> {
  const head = `${b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${b64url(JSON.stringify(payload))}`
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  return `${head}.${b64url(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(head)))}`
}

afterEach(() => {
  vi.useRealTimers()
})

describe('JWT issuer / audience', () => {
  it('accepts tokens minted by the same deployment, ignoring a trailing slash in APP_URL', async () => {
    const token = await createAccessToken('u1', 'member', prod)
    expect((await verifyAccessToken(token, { ...prod, APP_URL: 'https://zeta.example.com/' }))?.sub).toBe('u1')
    const [, body] = token.split('.')
    const claims = JSON.parse(atob(body!.replace(/-/g, '+').replace(/_/g, '/')))
    expect(claims).toMatchObject({ iss: 'https://zeta.example.com', aud: 'https://zeta.example.com' })
  })

  it('rejects tokens from another deployment that shares JWT_SECRET', async () => {
    expect(await verifyAccessToken(await createAccessToken('u1', 'admin', staging), prod)).toBeNull()
    expect(await verifyRefreshToken(await createRefreshToken('u1', staging), prod)).toBeNull()
  })

  it('keeps refresh tokens issued before the claims existed valid, but only those', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-20T00:00:00Z'))
    const iat = Math.floor(Date.now() / 1000) - 60
    const refresh = await legacyToken({ sub: 'u1', jti: 'j1', iat, exp: iat + 3600, type: 'refresh' }, prod.JWT_SECRET)
    expect((await verifyRefreshToken(refresh, prod))?.sub).toBe('u1')

    // Short-lived tokens need no grace period: an access token is simply refreshed.
    const access = await legacyToken(
      { sub: 'u1', role: 'admin', jti: 'j2', iat, exp: iat + 900, type: 'access' },
      prod.JWT_SECRET
    )
    expect(await verifyAccessToken(access, prod)).toBeNull()

    // Minted without claims after the cutoff: an outdated deployment sharing the secret.
    vi.setSystemTime(new Date('2026-11-03T00:00:00Z'))
    const late = Math.floor(Date.now() / 1000) - 60
    const stale = await legacyToken(
      { sub: 'u1', jti: 'j3', iat: late, exp: late + 3600, type: 'refresh' },
      prod.JWT_SECRET
    )
    expect(await verifyRefreshToken(stale, prod)).toBeNull()
  })
})

describe('password hashing', () => {
  it('round-trips with the iteration count Workers supports', async () => {
    const stored = await hashPassword('correct horse')
    expect(stored.startsWith('pbkdf2:100000:')).toBe(true)
    expect(await verifyPassword('correct horse', stored)).toBe(true)
    expect(await verifyPassword('wrong horse', stored)).toBe(false)
  })

  it('refuses hashes with more iterations than Workers can derive instead of throwing', async () => {
    const [, , salt, hash] = (await hashPassword('pw')).split(':')
    expect(await verifyPassword('pw', `pbkdf2:600000:${salt}:${hash}`)).toBe(false)
  })
})
