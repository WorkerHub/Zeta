import { describe, it, expect, vi, beforeEach } from 'vitest'
import { isoBase64URL } from '@simplewebauthn/server/helpers'
import { KV } from '../../lib/kv'
import type { UserRow, PasskeyCredentialRow } from '../../types'
import { bearer, callWorker, fakeD1, fakeEnv, postJson } from './fakes'

const { mockAuthVerifyState, verificationCalls } = vi.hoisted(() => ({
  mockAuthVerifyState: {
    verified: true,
    newCounter: 10,
    throwError: false,
  },
  verificationCalls: [] as Array<Record<string, unknown>>,
}))

vi.mock('@simplewebauthn/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@simplewebauthn/server')>()
  return {
    ...actual,
    verifyAuthenticationResponse: async (opts: Record<string, unknown>) => {
      verificationCalls.push(opts)
      if (mockAuthVerifyState.throwError) {
        throw new Error('WebAuthn verification threw')
      }
      if (!mockAuthVerifyState.verified) {
        return { verified: false }
      }
      return {
        verified: true,
        authenticationInfo: {
          newCounter: mockAuthVerifyState.newCounter,
        },
      }
    },
  }
})

describe('Passkey Discoverable Registration Options', () => {
  it('enforces residentKey: required and userVerification: required in registration options', async () => {
    const user: UserRow = {
      id: 'u-reg-1',
      email: 'resident@example.com',
      password_hash: 'hash',
      name: 'Resident User',
      role: 'member',
      email_verified: 1,
      two_factor_required: 0,
      created_at: 0,
      updated_at: 0,
    }
    const { db } = fakeD1((sql) => {
      if (sql.includes('SELECT id, email, name FROM users')) return { id: user.id, email: user.email, name: user.name }
      if (sql.includes('SELECT credential_id FROM passkey_credentials')) return [{ credential_id: 'existing-cred-1' }]
      return null
    })
    const env = fakeEnv({ DB: db })
    const headers = { ...(await bearer(env, user.id)), 'Content-Type': 'application/json' }
    const res = await callWorker(env, '/api/profile/passkey/register/options', {
      method: 'POST',
      headers,
    })
    expect(res.status).toBe(200)
    const options = (await res.json()) as Record<string, unknown>
    expect(options.authenticatorSelection).toMatchObject({
      residentKey: 'required',
      userVerification: 'required',
    })
    expect(options.user).toMatchObject({
      name: user.email,
      displayName: user.name,
    })
    expect(options.excludeCredentials).toEqual([{ id: 'existing-cred-1', type: 'public-key' }])
    // Challenge saved in KV
    expect(await env.KV.get(KV.passkeyRegChallenge(user.id))).toBe(options.challenge)
  })
})

describe('POST /api/auth/passkey/login/options', () => {
  it('generates authentication options without allowCredentials and requires UV', async () => {
    const env = fakeEnv({ APP_URL: 'https://zeta.example.com' })
    const res = await callWorker(env, '/api/auth/passkey/login/options', postJson({}))
    expect(res.status).toBe(200)
    const options = (await res.json()) as Record<string, unknown>

    expect(options.rpId).toBe('zeta.example.com')
    expect(options.userVerification).toBe('required')
    expect(options.allowCredentials).toBeUndefined()
    expect(typeof options.challenge).toBe('string')

    // Stored in KV with 5-minute TTL key
    const stored = await env.KV.get(KV.passkeyLoginChallenge(options.challenge as string))
    expect(stored).toBe(options.challenge)
  })

  it('rate limits options requests after 30 attempts per 15 minutes', async () => {
    const env = fakeEnv()
    for (let i = 0; i < 30; i++) {
      const res = await callWorker(env, '/api/auth/passkey/login/options', postJson({}))
      expect(res.status).toBe(200)
    }
    const blocked = await callWorker(env, '/api/auth/passkey/login/options', postJson({}))
    expect(blocked.status).toBe(429)
    expect(await blocked.json()).toMatchObject({ error: expect.stringContaining('Too many requests') })
  })

  it('rejects options request when IP is already locked out from failed logins', async () => {
    const env = fakeEnv()
    // Simulate 21 failed login attempts from this IP
    for (let i = 0; i < 21; i++) {
      await callWorker(env, '/api/auth/login', postJson({ email: 'any@example.com', password: 'bad' }))
    }
    const res = await callWorker(env, '/api/auth/passkey/login/options', postJson({}))
    expect(res.status).toBe(429)
  })
})

describe('POST /api/auth/passkey/login/verify', () => {
  const dummyPublicKey = isoBase64URL.fromBuffer(new Uint8Array([1, 2, 3, 4]))
  const toB64Url = (str: string) => isoBase64URL.fromBuffer(new TextEncoder().encode(str) as Uint8Array<ArrayBuffer>)

  const testUser: UserRow = {
    id: 'user-uuid-1234',
    email: 'passkey.user@example.com',
    password_hash: 'dummy',
    name: 'Passkey User',
    role: 'member',
    email_verified: 1,
    two_factor_required: 1, // Has 2FA enabled, but passkey should bypass secondary prompt
    created_at: 1000,
    updated_at: 1000,
  }
  const testCred: PasskeyCredentialRow = {
    id: 'cred-row-1',
    user_id: testUser.id,
    credential_id: 'test-cred-id',
    public_key: dummyPublicKey,
    sign_count: 5,
    name: 'My Security Key',
    created_at: 1000,
  }

  beforeEach(() => {
    mockAuthVerifyState.verified = true
    mockAuthVerifyState.newCounter = 10
    mockAuthVerifyState.throwError = false
    verificationCalls.length = 0
  })

  function setupVerifyEnv(opts?: {
    user?: UserRow | null
    cred?: PasskeyCredentialRow | null
    requireEmailVerification?: string
  }) {
    let currentSignCount = opts?.cred ? opts.cred.sign_count : testCred.sign_count
    const effectiveUser = opts?.user !== undefined ? opts.user : testUser
    const effectiveCred = opts?.cred !== undefined ? opts.cred : testCred

    const { db, calls } = fakeD1((sql, args) => {
      if (sql.includes('SELECT id, user_id, credential_id, public_key, sign_count FROM passkey_credentials')) {
        if (effectiveCred && args[0] === effectiveCred.credential_id) {
          return { ...effectiveCred, sign_count: currentSignCount }
        }
        return null
      }
      if (sql.includes('SELECT * FROM users WHERE id = ?1')) {
        if (effectiveUser && args[0] === effectiveUser.id) {
          return effectiveUser
        }
        return null
      }
      if (sql.includes('UPDATE passkey_credentials SET sign_count = ?1 WHERE id = ?2')) {
        currentSignCount = args[0] as number
        return null
      }
      if (sql.includes('SELECT value FROM settings WHERE key = ?1')) {
        if (args[0] === 'require_email_verification') {
          return opts?.requireEmailVerification ? { value: opts.requireEmailVerification } : null
        }
        return null
      }
      return null
    })

    const env = fakeEnv({ DB: db, APP_URL: 'https://zeta.example.com' })
    return { env, calls, getCurrentSignCount: () => currentSignCount }
  }

  function makeClientDataJSON(challenge: string): string {
    return toB64Url(
      JSON.stringify({
        type: 'webauthn.get',
        challenge,
        origin: 'https://zeta.example.com',
      })
    )
  }

  it('rejects invalid request bodies with 400', async () => {
    const { env } = setupVerifyEnv()
    expect((await callWorker(env, '/api/auth/passkey/login/verify', postJson([]))).status).toBe(400)
    expect((await callWorker(env, '/api/auth/passkey/login/verify', { method: 'POST', body: 'not-json' })).status).toBe(
      400
    )
  })

  it('returns unified 401 when challenge is missing or not in KV', async () => {
    const { env } = setupVerifyEnv()
    // No challenge at all
    const resNoCh = await callWorker(env, '/api/auth/passkey/login/verify', postJson({ id: testCred.credential_id }))
    expect(resNoCh.status).toBe(401)
    expect(await resNoCh.json()).toEqual({ error: 'Invalid credentials' })

    // Challenge in body but not in KV (or expired)
    const resBadCh = await callWorker(
      env,
      '/api/auth/passkey/login/verify',
      postJson({ id: testCred.credential_id, challenge: 'nonexistent-ch' })
    )
    expect(resBadCh.status).toBe(401)
    expect(await resBadCh.json()).toEqual({ error: 'Invalid credentials' })
  })

  it('enforces single-use challenge consumption (replay protection)', async () => {
    const { env } = setupVerifyEnv()
    const challenge = 'single-use-ch-1'
    await env.KV.put(KV.passkeyLoginChallenge(challenge), challenge)

    const payload = {
      id: testCred.credential_id,
      challenge,
      response: {
        clientDataJSON: makeClientDataJSON(challenge),
        userHandle: toB64Url(testUser.id),
      },
    }

    const first = await callWorker(env, '/api/auth/passkey/login/verify', postJson(payload))
    expect(first.status).toBe(200)

    // Challenge should be deleted from KV
    expect(await env.KV.get(KV.passkeyLoginChallenge(challenge))).toBeNull()

    // Replay attack with same payload should return 401
    const replay = await callWorker(env, '/api/auth/passkey/login/verify', postJson(payload))
    expect(replay.status).toBe(401)
    expect(await replay.json()).toEqual({ error: 'Invalid credentials' })
  })

  it('returns unified 401 anti-probing error when credential or user does not exist', async () => {
    const { env } = setupVerifyEnv({ cred: null })
    const challenge = 'test-challenge-unknown'
    await env.KV.put(KV.passkeyLoginChallenge(challenge), challenge)

    const resUnknownCred = await callWorker(
      env,
      '/api/auth/passkey/login/verify',
      postJson({
        id: 'nonexistent-cred',
        challenge,
        response: { clientDataJSON: makeClientDataJSON(challenge) },
      })
    )
    expect(resUnknownCred.status).toBe(401)
    expect(await resUnknownCred.json()).toEqual({ error: 'Invalid credentials' })
  })

  it('returns unified 401 when userHandle mismatches user.id', async () => {
    const { env } = setupVerifyEnv()
    const challenge = 'ch-mismatch'
    await env.KV.put(KV.passkeyLoginChallenge(challenge), challenge)

    const res = await callWorker(
      env,
      '/api/auth/passkey/login/verify',
      postJson({
        id: testCred.credential_id,
        challenge,
        response: {
          clientDataJSON: makeClientDataJSON(challenge),
          userHandle: toB64Url('wrong-user-id'),
        },
      })
    )
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'Invalid credentials' })
  })

  it('returns unified 401 when WebAuthn verification fails or throws', async () => {
    const { env } = setupVerifyEnv()
    const challenge = 'ch-fail'
    await env.KV.put(KV.passkeyLoginChallenge(challenge), challenge)

    mockAuthVerifyState.verified = false
    const resFail = await callWorker(
      env,
      '/api/auth/passkey/login/verify',
      postJson({
        id: testCred.credential_id,
        challenge,
        response: { clientDataJSON: makeClientDataJSON(challenge) },
      })
    )
    expect(resFail.status).toBe(401)
    expect(await resFail.json()).toEqual({ error: 'Invalid credentials' })

    // When verification throws
    const challengeThrow = 'ch-throw'
    await env.KV.put(KV.passkeyLoginChallenge(challengeThrow), challengeThrow)
    mockAuthVerifyState.throwError = true
    const resThrow = await callWorker(
      env,
      '/api/auth/passkey/login/verify',
      postJson({
        id: testCred.credential_id,
        challenge: challengeThrow,
        response: { clientDataJSON: makeClientDataJSON(challengeThrow) },
      })
    )
    expect(resThrow.status).toBe(401)
    expect(await resThrow.json()).toEqual({ error: 'Invalid credentials' })
  })

  it('enforces email verification gate matching password login', async () => {
    const unverifiedUser: UserRow = {
      ...testUser,
      email_verified: 0,
    }
    const { env } = setupVerifyEnv({ user: unverifiedUser, requireEmailVerification: 'true' })
    const challenge = 'ch-unverified'
    await env.KV.put(KV.passkeyLoginChallenge(challenge), challenge)

    const res = await callWorker(
      env,
      '/api/auth/passkey/login/verify',
      postJson({
        id: testCred.credential_id,
        challenge,
        response: { clientDataJSON: makeClientDataJSON(challenge) },
      })
    )
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'Please verify your email before logging in.' })
  })

  it('succeeds, updates sign_count, sets refresh cookie and issues access token directly skipping 2FA', async () => {
    const { env, getCurrentSignCount, calls } = setupVerifyEnv()
    const challenge = 'success-ch'
    await env.KV.put(KV.passkeyLoginChallenge(challenge), challenge)
    mockAuthVerifyState.newCounter = 12

    const res = await callWorker(
      env,
      '/api/auth/passkey/login/verify',
      postJson({
        credential: {
          id: testCred.credential_id,
          response: {
            clientDataJSON: makeClientDataJSON(challenge),
            userHandle: toB64Url(testUser.id),
          },
        },
      })
    )
    expect(res.status).toBe(200)
    const data = (await res.json()) as Record<string, unknown>
    expect(typeof data.accessToken).toBe('string')
    expect(data.user).toEqual({
      id: testUser.id,
      email: testUser.email,
      name: testUser.name,
      role: testUser.role,
    })

    // Does not return requires2fa or pendingToken
    expect(data.requires2fa).toBeUndefined()
    expect(data.pendingToken).toBeUndefined()

    // Refresh cookie set
    const cookie = res.headers.get('Set-Cookie')
    expect(cookie).toContain('refresh_token=')
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('SameSite=Strict')

    // Counter updated in DB
    expect(getCurrentSignCount()).toBe(12)

    // Audit log written
    const auditCall = calls.find((c) => c.sql.includes('INSERT INTO audit_logs'))
    expect(auditCall).toBeDefined()
    expect(auditCall?.args).toContain('login_passkey')
  })

  it('rate limits login attempts by IP (>20 attempts)', async () => {
    const { env } = setupVerifyEnv()
    const statuses: number[] = []
    for (let i = 0; i < 22; i++) {
      const challenge = `ch-ip-rate-${i}`
      await env.KV.put(KV.passkeyLoginChallenge(challenge), challenge)
      const res = await callWorker(
        env,
        '/api/auth/passkey/login/verify',
        postJson({
          id: 'bad-cred',
          challenge,
          response: { clientDataJSON: makeClientDataJSON(challenge) },
        })
      )
      statuses.push(res.status)
    }
    expect(statuses.slice(0, 20).every((s) => s === 401)).toBe(true)
    expect(statuses.slice(20).every((s) => s === 429)).toBe(true)
  })

  it('rate limits account after 10 failed attempts for that user', async () => {
    const { env } = setupVerifyEnv()
    mockAuthVerifyState.verified = false

    const statuses: number[] = []
    for (let i = 0; i < 12; i++) {
      const challenge = `ch-acct-rate-${i}`
      await env.KV.put(KV.passkeyLoginChallenge(challenge), challenge)
      const res = await callWorker(
        env,
        '/api/auth/passkey/login/verify',
        postJson({
          id: testCred.credential_id,
          challenge,
          response: { clientDataJSON: makeClientDataJSON(challenge) },
        })
      )
      statuses.push(res.status)
    }
    expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true)
    expect(statuses.slice(10).every((s) => s === 429)).toBe(true)
  })
})
