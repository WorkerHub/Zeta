import { describe, it, expect, vi } from 'vitest'
import { isoBase64URL } from '@simplewebauthn/server/helpers'
import { createPending2faToken } from '../../lib/auth'
import { KV } from '../../lib/kv'
import { bearer, callWorker, fakeD1, fakeEnv, postJson } from './fakes'

// For a deployment without APP_URL the assertion that matters is what reaches the WebAuthn
// verification: expectedOrigin / expectedRPID. Capture those arguments instead of running a real
// ceremony.
const { verificationCalls } = vi.hoisted(() => ({ verificationCalls: [] as Array<Record<string, unknown>> }))

vi.mock('@simplewebauthn/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@simplewebauthn/server')>()
  return {
    ...actual,
    verifyRegistrationResponse: async (opts: Record<string, unknown>) => {
      verificationCalls.push(opts)
      return { verified: false }
    },
    verifyAuthenticationResponse: async (opts: Record<string, unknown>) => {
      verificationCalls.push(opts)
      return { verified: false }
    },
  }
})

const https = 'https://zeta.example.com'
const local = 'http://localhost:8787'

async function registerVerify(appUrl: string | undefined, origin: string) {
  const env = fakeEnv({ APP_URL: appUrl })
  await env.KV.put(KV.passkeyRegChallenge('u1'), 'challenge')
  verificationCalls.length = 0
  const res = await callWorker(env, `${origin}/api/profile/passkey/register/verify`, {
    ...postJson({ id: 'cred-1' }),
    headers: { ...(await bearer(env, 'u1')), 'Content-Type': 'application/json' },
  })
  return { status: res.status, call: verificationCalls.at(-1) }
}

async function loginVerify(appUrl: string | undefined, origin: string) {
  const { db } = fakeD1((sql) =>
    sql.includes('SELECT id, credential_id, public_key, sign_count')
      ? {
          id: 1,
          credential_id: 'cred-1',
          public_key: isoBase64URL.fromBuffer(new Uint8Array([1, 2, 3])),
          sign_count: 0,
        }
      : null
  )
  const env = fakeEnv({ APP_URL: appUrl, DB: db })
  await env.KV.put(KV.passkeyChallenge('u1'), 'challenge')
  const pendingToken = await createPending2faToken('u1', env)
  verificationCalls.length = 0
  const res = await callWorker(
    env,
    `${origin}/api/auth/2fa/passkey/verify`,
    postJson({ pendingToken, credential: { id: 'cred-1' } })
  )
  return { status: res.status, call: verificationCalls.at(-1) }
}

describe('passkey verification target', () => {
  it('uses the configured APP_URL', async () => {
    const reg = await registerVerify('https://configured.example.com/', https)
    expect(reg.status).toBe(400)
    expect(reg.call).toMatchObject({
      expectedOrigin: 'https://configured.example.com',
      expectedRPID: 'configured.example.com',
    })

    const login = await loginVerify('https://configured.example.com/', https)
    expect(login.status).toBe(400)
    expect(login.call).toMatchObject({
      expectedOrigin: 'https://configured.example.com',
      expectedRPID: 'configured.example.com',
    })
  })

  it('derives expectedOrigin and expectedRPID from the request when APP_URL is unset', async () => {
    const regHttps = await registerVerify(undefined, https)
    expect(regHttps.status).toBe(400)
    expect(regHttps.call).toMatchObject({ expectedOrigin: https, expectedRPID: 'zeta.example.com' })

    const regLocal = await registerVerify(undefined, local)
    expect(regLocal.call).toMatchObject({ expectedOrigin: local, expectedRPID: 'localhost' })

    const loginHttps = await loginVerify(undefined, https)
    expect(loginHttps.status).toBe(400)
    expect(loginHttps.call).toMatchObject({ expectedOrigin: https, expectedRPID: 'zeta.example.com' })

    const loginLocal = await loginVerify(undefined, local)
    expect(loginLocal.call).toMatchObject({ expectedOrigin: local, expectedRPID: 'localhost' })
  })
})
