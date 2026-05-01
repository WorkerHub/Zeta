import { Hono } from 'hono'
import type { Env, Variables, UserRow, TotpCredentialRow, PasskeyCredentialRow } from '../types'
import { requireAuth } from '../middleware/auth'
import { nanoid, uuid } from '../lib/id'
import { now, audit, tables } from '../lib/db'
import { hashPassword, verifyPassword } from '../lib/auth'
import {
  generateTotpSecret, encryptTotpSecret, decryptTotpSecret,
  getTotpUri, verifyTotpCode,
} from '../lib/totp'
import {
  generateRegistrationOptions, verifyRegistrationResponse,
  generateAuthenticationOptions, verifyAuthenticationResponse,
} from '@simplewebauthn/server'
import { isoBase64URL } from '@simplewebauthn/server/helpers'
import { KV } from '../lib/kv'

const profile = new Hono<{ Bindings: Env; Variables: Variables }>()
profile.use('*', requireAuth)

function clientIp(c: { req: { header: (k: string) => string | undefined } }): string {
  return c.req.header('cf-connecting-ip') ?? 'unknown'
}

// ── GET /api/profile/me ───────────────────────────────────────────────────────

profile.get('/me', async (c) => {
  const T = tables(c.env)
  const user = await c.env.DB.prepare(
    `SELECT id, email, name, role, email_verified, two_factor_required, created_at FROM ${T.users} WHERE id = ?1`
  ).bind(c.get('userId')).first<Omit<UserRow, 'password_hash' | 'updated_at'>>()
  if (!user) return c.json({ error: 'User not found' }, 404)

  const totpRows = await c.env.DB.prepare(
    `SELECT id, name, created_at FROM ${T.totp_credentials} WHERE user_id = ?1`
  ).bind(user.id).all<Pick<TotpCredentialRow, 'id' | 'name' | 'created_at'>>()
  const passkeyRows = await c.env.DB.prepare(
    `SELECT id, name, created_at FROM ${T.passkey_credentials} WHERE user_id = ?1`
  ).bind(user.id).all<Pick<PasskeyCredentialRow, 'id' | 'name' | 'created_at'>>()

  return c.json({
    ...user,
    totpCredentials: totpRows.results,
    passkeyCredentials: passkeyRows.results,
  })
})

// ── PATCH /api/profile/me ─────────────────────────────────────────────────────

profile.patch('/me', async (c) => {
  const body = await c.req.json<{ name?: string }>().catch(() => null)
  if (!body?.name?.trim()) return c.json({ error: 'name is required' }, 400)
  const T = tables(c.env)
  await c.env.DB.prepare(`UPDATE ${T.users} SET name = ?1, updated_at = ?2 WHERE id = ?3`)
    .bind(body.name.trim(), now(), c.get('userId')).run()
  return c.json({ message: 'Updated' })
})

// ── POST /api/profile/change-password ────────────────────────────────────────

profile.post('/change-password', async (c) => {
  const body = await c.req.json<{ currentPassword?: string; newPassword?: string }>().catch(() => null)
  if (!body?.currentPassword || !body.newPassword) {
    return c.json({ error: 'currentPassword and newPassword are required' }, 400)
  }
  if (body.newPassword.length < 8) return c.json({ error: 'Password must be at least 8 characters' }, 400)

  const T = tables(c.env)
  const user = await c.env.DB.prepare(`SELECT password_hash FROM ${T.users} WHERE id = ?1`)
    .bind(c.get('userId')).first<{ password_hash: string | null }>()
  if (!user?.password_hash) return c.json({ error: 'No password set' }, 400)

  if (!(await verifyPassword(body.currentPassword, user.password_hash))) {
    return c.json({ error: 'Current password is incorrect' }, 401)
  }

  const hash = await hashPassword(body.newPassword)
  await c.env.DB.prepare(`UPDATE ${T.users} SET password_hash = ?1, updated_at = ?2 WHERE id = ?3`)
    .bind(hash, now(), c.get('userId')).run()

  c.executionCtx.waitUntil(audit(c.env, { userId: c.get('userId'), action: 'change_password', ip: clientIp(c) }))
  return c.json({ message: 'Password changed' })
})

// ── TOTP Setup ────────────────────────────────────────────────────────────────

profile.post('/totp/setup', async (c) => {
  const T = tables(c.env)
  const user = await c.env.DB.prepare(`SELECT email FROM ${T.users} WHERE id = ?1`)
    .bind(c.get('userId')).first<{ email: string }>()
  if (!user) return c.json({ error: 'User not found' }, 404)

  const secret = generateTotpSecret()
  // Store plaintext secret temporarily in KV (5min) before user confirms
  await c.env.KV.put(`totp_setup:${c.get('userId')}`, secret, { expirationTtl: 300 })

  const appName = 'Zeta'
  const uri = getTotpUri(secret, user.email, appName)

  return c.json({ secret, uri })
})

profile.post('/totp/confirm', async (c) => {
  const body = await c.req.json<{ code?: string; name?: string }>().catch(() => null)
  if (!body?.code) return c.json({ error: 'code is required' }, 400)

  const secret = await c.env.KV.get(`totp_setup:${c.get('userId')}`)
  if (!secret) return c.json({ error: 'Setup session expired. Start over.' }, 400)

  if (!verifyTotpCode(secret, body.code)) return c.json({ error: 'Invalid code' }, 401)

  const encryptedSecret = await encryptTotpSecret(c.env, secret)
  await c.env.KV.delete(`totp_setup:${c.get('userId')}`)

  const T = tables(c.env)
  const id = uuid()
  await c.env.DB.prepare(
    `INSERT INTO ${T.totp_credentials} (id, user_id, encrypted_secret, name, created_at) VALUES (?1, ?2, ?3, ?4, ?5)`
  ).bind(id, c.get('userId'), encryptedSecret, body.name?.trim() || 'Authenticator', now()).run()

  return c.json({ message: 'TOTP authenticator added' })
})

profile.delete('/totp/:id', async (c) => {
  const T = tables(c.env)
  const id = c.req.param('id')
  await c.env.DB.prepare(`DELETE FROM ${T.totp_credentials} WHERE id = ?1 AND user_id = ?2`)
    .bind(id, c.get('userId')).run()
  return c.json({ message: 'TOTP credential removed' })
})

// ── Passkey (WebAuthn) ────────────────────────────────────────────────────────

profile.post('/passkey/register/options', async (c) => {
  const T = tables(c.env)
  const user = await c.env.DB.prepare(`SELECT id, email, name FROM ${T.users} WHERE id = ?1`)
    .bind(c.get('userId')).first<{ id: string; email: string; name: string }>()
  if (!user) return c.json({ error: 'User not found' }, 404)

  const existingCredentials = await c.env.DB.prepare(
    `SELECT credential_id FROM ${T.passkey_credentials} WHERE user_id = ?1`
  ).bind(user.id).all<{ credential_id: string }>()

  const appUrl = new URL(c.env.APP_URL)
  const options = await generateRegistrationOptions({
    rpName: 'Zeta',
    rpID: appUrl.hostname,
    userID: new TextEncoder().encode(user.id) as Uint8Array<ArrayBuffer>,
    userName: user.email,
    userDisplayName: user.name,
    excludeCredentials: existingCredentials.results.map((r) => ({
      id: r.credential_id,
    })),
    authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
  })

  await c.env.KV.put(KV.passkeyChallenge(user.id), options.challenge, { expirationTtl: 300 })
  return c.json(options)
})

profile.post('/passkey/register/verify', async (c) => {
  const body = await c.req.json().catch(() => null)
  if (!body) return c.json({ error: 'Invalid body' }, 400)

  const expectedChallenge = await c.env.KV.get(KV.passkeyChallenge(c.get('userId')))
  if (!expectedChallenge) return c.json({ error: 'Challenge expired' }, 400)

  const appUrl = new URL(c.env.APP_URL)
  const verification = await verifyRegistrationResponse({
    response: body,
    expectedChallenge,
    expectedOrigin: c.req.header('origin') ?? c.env.APP_URL.replace(/\/$/, ''),
    expectedRPID: appUrl.hostname,
    requireUserVerification: false,
  })

  if (!verification.verified || !verification.registrationInfo) {
    return c.json({ error: 'Verification failed' }, 400)
  }

  await c.env.KV.delete(KV.passkeyChallenge(c.get('userId')))

  const { credential } = verification.registrationInfo
  const credId = credential.id
  const pubKey = isoBase64URL.fromBuffer(credential.publicKey as Uint8Array<ArrayBuffer>)
  const counter = credential.counter
  const name = 'Passkey'

  const T = tables(c.env)
  await c.env.DB.prepare(
    `INSERT INTO ${T.passkey_credentials} (id, user_id, credential_id, public_key, sign_count, name, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`
  ).bind(uuid(), c.get('userId'), credId, pubKey, counter, name, now()).run()

  return c.json({ message: 'Passkey registered' })
})

profile.delete('/passkey/:id', async (c) => {
  const T = tables(c.env)
  const id = c.req.param('id')
  await c.env.DB.prepare(`DELETE FROM ${T.passkey_credentials} WHERE id = ?1 AND user_id = ?2`)
    .bind(id, c.get('userId')).run()
  return c.json({ message: 'Passkey removed' })
})

export default profile
