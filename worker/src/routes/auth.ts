import { Hono } from 'hono'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'
import type { Env, Variables, UserRow, PasskeyCredentialRow } from '../types'
import { nanoid, uuid } from '../lib/id'
import { now, getSetting, audit, tables } from '../lib/db'
import { KV } from '../lib/kv'
import {
  hashPassword, verifyPassword,
  createAccessToken, createRefreshToken, createPending2faToken,
  verifyRefreshToken, verifyPending2faToken,
  revokeRefreshToken, isRefreshTokenRevoked,
  checkLoginRateLimit, incrementLoginAttempts, resetLoginAttempts,
} from '../lib/auth'
import { sendEmail, buildVerificationEmail, buildPasswordResetEmail, buildOtpEmail } from '../lib/email'
import { verifyTotpCode, decryptTotpSecret } from '../lib/totp'
import {
  generateAuthenticationOptions, verifyAuthenticationResponse,
} from '@simplewebauthn/server'
import { isoBase64URL } from '@simplewebauthn/server/helpers'

const auth = new Hono<{ Bindings: Env; Variables: Variables }>()

// ── Helpers ───────────────────────────────────────────────────────────────────

function clientIp(c: { req: { header: (k: string) => string | undefined } }): string {
  return c.req.header('cf-connecting-ip') ?? 'unknown'
}

function setRefreshCookie(c: { header: (k: string, v: string) => void }, token: string, secure: boolean): void {
  const maxAge = 7 * 24 * 3600
  const flags = `HttpOnly; Path=/; Max-Age=${maxAge}; SameSite=Strict${secure ? '; Secure' : ''}`
  c.header('Set-Cookie', `refresh_token=${token}; ${flags}`)
}

function clearRefreshCookie(c: { header: (k: string, v: string) => void }, secure: boolean): void {
  const flags = `HttpOnly; Path=/; Max-Age=0; SameSite=Strict${secure ? '; Secure' : ''}`
  c.header('Set-Cookie', `refresh_token=; ${flags}`)
}

const isSecure = (env: Env) => env.APP_URL?.startsWith('https')

// ── POST /api/auth/register ───────────────────────────────────────────────────

auth.post('/register', async (c) => {
  const regEnabled = await getSetting(c.env, 'registration_enabled')
  if (regEnabled === 'false') return c.json({ error: 'Registration is disabled' }, 403)

  const body = await c.req.json<{ email?: string; password?: string; name?: string }>().catch(() => null)
  if (!body?.email || !body.password || !body.name) {
    return c.json({ error: 'email, password, and name are required' }, 400)
  }

  const email = body.email.toLowerCase().trim()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return c.json({ error: 'Invalid email' }, 400)
  if (body.password.length < 8) return c.json({ error: 'Password must be at least 8 characters' }, 400)
  if (body.name.trim().length < 1) return c.json({ error: 'Name is required' }, 400)

  const T = tables(c.env)
  const existing = await c.env.DB.prepare(`SELECT id FROM ${T.users} WHERE email = ?1`).bind(email).first()
  if (existing) return c.json({ error: 'Email already registered' }, 409)

  // First registered user becomes admin
  const countRow = await c.env.DB.prepare(`SELECT COUNT(*) as n FROM ${T.users}`).first<{ n: number }>()
  const isFirstUser = (countRow?.n ?? 0) === 0

  const id = uuid()
  const passwordHash = await hashPassword(body.password)
  const ts = now()

  await c.env.DB.prepare(
    `INSERT INTO ${T.users} (id, email, password_hash, name, role, email_verified, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)`
  ).bind(id, email, passwordHash, body.name.trim(), isFirstUser ? 'admin' : 'member', 0, ts).run()

  // Email verification
  const requireVerify = await getSetting(c.env, 'require_email_verification')
  if (requireVerify !== 'false') {
    const token = nanoid(32)
    await c.env.KV.put(KV.emailVerify(token), id, { expirationTtl: 24 * 3600 })
    const appName = (await getSetting(c.env, 'app_name')) ?? 'Zeta'
    await sendEmail(c.env, buildVerificationEmail({
      appName, appUrl: c.env.APP_URL, toEmail: email, token
    })).catch(() => { /* non-fatal – user can resend */ })
  }

  c.executionCtx.waitUntil(audit(c.env, {
    userId: id, action: 'register', ip: clientIp(c)
  }))

  return c.json({ message: 'Registered. Please verify your email.' }, 201)
})

// ── GET /api/auth/verify-email ────────────────────────────────────────────────

auth.get('/verify-email', async (c) => {
  const token = c.req.query('token')
  if (!token) return c.json({ error: 'Missing token' }, 400)

  const userId = await c.env.KV.get(KV.emailVerify(token))
  if (!userId) return c.json({ error: 'Invalid or expired token' }, 400)

  const T = tables(c.env)
  await c.env.DB.prepare(
    `UPDATE ${T.users} SET email_verified = 1, updated_at = ?1 WHERE id = ?2`
  ).bind(now(), userId).run()
  await c.env.KV.delete(KV.emailVerify(token))

  return c.json({ message: 'Email verified. You can now log in.' })
})

// ── POST /api/auth/resend-verification ───────────────────────────────────────

auth.post('/resend-verification', async (c) => {
  const body = await c.req.json<{ email?: string }>().catch(() => null)
  if (!body?.email) return c.json({ error: 'email is required' }, 400)

  const email = body.email.toLowerCase().trim()
  const T = tables(c.env)
  const user = await c.env.DB.prepare(`SELECT id, email_verified FROM ${T.users} WHERE email = ?1`)
    .bind(email).first<{ id: string; email_verified: number }>()
  // Always return 200 to avoid user enumeration
  if (!user || user.email_verified === 1) return c.json({ message: 'If the address exists, a new link was sent.' })

  const token = nanoid(32)
  await c.env.KV.put(KV.emailVerify(token), user.id, { expirationTtl: 24 * 3600 })
  const appName = (await getSetting(c.env, 'app_name')) ?? 'Zeta'
  await sendEmail(c.env, buildVerificationEmail({
    appName, appUrl: c.env.APP_URL, toEmail: email, token
  })).catch(() => {})

  return c.json({ message: 'If the address exists, a new link was sent.' })
})

// ── POST /api/auth/login ──────────────────────────────────────────────────────

auth.post('/login', async (c) => {
  const ip = clientIp(c)
  if (!(await checkLoginRateLimit(c.env, ip))) {
    return c.json({ error: 'Too many login attempts. Try again later.' }, 429)
  }

  const body = await c.req.json<{ email?: string; password?: string }>().catch(() => null)
  if (!body?.email || !body.password) return c.json({ error: 'email and password are required' }, 400)

  const email = body.email.toLowerCase().trim()
  const T = tables(c.env)
  const user = await c.env.DB.prepare(`SELECT * FROM ${T.users} WHERE email = ?1`).bind(email).first<UserRow>()

  // Constant-time failure to avoid timing attacks on user enumeration
  const hashToCheck = user?.password_hash ?? 'pbkdf2:100000:0000000000000000000000000000000000000000000000000000000000000000:0000000000000000000000000000000000000000000000000000000000000000'
  const valid = await verifyPassword(body.password, hashToCheck)

  if (!user || !valid) {
    await incrementLoginAttempts(c.env, ip)
    return c.json({ error: 'Invalid email or password' }, 401)
  }

  const requireVerify = await getSetting(c.env, 'require_email_verification')
  if (requireVerify !== 'false' && user.email_verified === 0) {
    return c.json({ error: 'Please verify your email before logging in.' }, 403)
  }

  await resetLoginAttempts(c.env, ip)

  // Check if 2FA is required
  const enforce2fa = await getSetting(c.env, 'enforce_2fa')
  const hasTotpOrPasskey = await c.env.DB.prepare(
    `SELECT 1 FROM ${T.totp_credentials} WHERE user_id = ?1
     UNION SELECT 1 FROM ${T.passkey_credentials} WHERE user_id = ?1`
  ).bind(user.id).first()
  const needs2fa = enforce2fa === 'true' || user.two_factor_required === 1 || hasTotpOrPasskey !== null

  if (needs2fa) {
    const pendingToken = await createPending2faToken(user.id, c.env.JWT_SECRET)
    c.executionCtx.waitUntil(audit(c.env, { userId: user.id, action: 'login_2fa_required', ip }))
    return c.json({ requires2fa: true, pendingToken, userId: user.id })
  }

  const accessToken = await createAccessToken(user.id, user.role, c.env.JWT_SECRET)
  const refreshToken = await createRefreshToken(user.id, c.env.JWT_SECRET)
  setRefreshCookie(c, refreshToken, isSecure(c.env))

  c.executionCtx.waitUntil(audit(c.env, { userId: user.id, action: 'login', ip }))
  return c.json({ accessToken, user: { id: user.id, email: user.email, name: user.name, role: user.role } })
})

// ── POST /api/auth/2fa/totp ───────────────────────────────────────────────────

auth.post('/2fa/totp', async (c) => {
  const body = await c.req.json<{ pendingToken?: string; code?: string }>().catch(() => null)
  if (!body?.pendingToken || !body.code) return c.json({ error: 'pendingToken and code are required' }, 400)

  const pending = await verifyPending2faToken(body.pendingToken, c.env.JWT_SECRET)
  if (!pending) return c.json({ error: 'Invalid or expired token' }, 401)

  const T = tables(c.env)
  const totp = await c.env.DB.prepare(
    `SELECT encrypted_secret FROM ${T.totp_credentials} WHERE user_id = ?1`
  ).bind(pending.sub).first<{ encrypted_secret: string }>()
  if (!totp) return c.json({ error: 'TOTP not configured' }, 400)

  const secret = await decryptTotpSecret(c.env, totp.encrypted_secret)
  if (!verifyTotpCode(secret, body.code)) return c.json({ error: 'Invalid code' }, 401)

  const user = await c.env.DB.prepare(`SELECT * FROM ${T.users} WHERE id = ?1`).bind(pending.sub).first<UserRow>()
  if (!user) return c.json({ error: 'User not found' }, 404)

  const accessToken = await createAccessToken(user.id, user.role, c.env.JWT_SECRET)
  const refreshToken = await createRefreshToken(user.id, c.env.JWT_SECRET)
  setRefreshCookie(c, refreshToken, isSecure(c.env))

  c.executionCtx.waitUntil(audit(c.env, { userId: user.id, action: 'login_2fa_totp', ip: clientIp(c) }))
  return c.json({ accessToken, user: { id: user.id, email: user.email, name: user.name, role: user.role } })
})

// ── POST /api/auth/2fa/email-otp ──────────────────────────────────────────────

auth.post('/2fa/email-otp/send', async (c) => {
  const body = await c.req.json<{ pendingToken?: string }>().catch(() => null)
  if (!body?.pendingToken) return c.json({ error: 'pendingToken is required' }, 400)

  const pending = await verifyPending2faToken(body.pendingToken, c.env.JWT_SECRET)
  if (!pending) return c.json({ error: 'Invalid or expired token' }, 401)

  const T = tables(c.env)
  const user = await c.env.DB.prepare(`SELECT email FROM ${T.users} WHERE id = ?1`)
    .bind(pending.sub).first<{ email: string }>()
  if (!user) return c.json({ error: 'User not found' }, 404)

  // Generate 6-digit OTP
  const otp = String(Math.floor(100000 + Math.random() * 900000))
  await c.env.KV.put(KV.emailOtp(pending.sub), otp, { expirationTtl: 600 })

  const appName = (await getSetting(c.env, 'app_name')) ?? 'Zeta'
  await sendEmail(c.env, buildOtpEmail({ appName, toEmail: user.email, otp }))

  return c.json({ message: 'OTP sent' })
})

auth.post('/2fa/email-otp/verify', async (c) => {
  const body = await c.req.json<{ pendingToken?: string; code?: string }>().catch(() => null)
  if (!body?.pendingToken || !body.code) return c.json({ error: 'pendingToken and code are required' }, 400)

  const pending = await verifyPending2faToken(body.pendingToken, c.env.JWT_SECRET)
  if (!pending) return c.json({ error: 'Invalid or expired token' }, 401)

  const stored = await c.env.KV.get(KV.emailOtp(pending.sub))
  if (!stored || stored !== body.code) return c.json({ error: 'Invalid or expired code' }, 401)

  await c.env.KV.delete(KV.emailOtp(pending.sub))

  const T = tables(c.env)
  const user = await c.env.DB.prepare(`SELECT * FROM ${T.users} WHERE id = ?1`).bind(pending.sub).first<UserRow>()
  if (!user) return c.json({ error: 'User not found' }, 404)

  const accessToken = await createAccessToken(user.id, user.role, c.env.JWT_SECRET)
  const refreshToken = await createRefreshToken(user.id, c.env.JWT_SECRET)
  setRefreshCookie(c, refreshToken, isSecure(c.env))

  c.executionCtx.waitUntil(audit(c.env, { userId: user.id, action: 'login_2fa_email_otp', ip: clientIp(c) }))
  return c.json({ accessToken, user: { id: user.id, email: user.email, name: user.name, role: user.role } })
})

// ── POST /api/auth/refresh ────────────────────────────────────────────────────

auth.post('/refresh', async (c) => {
  const cookieToken = getCookie(c, 'refresh_token')
  if (!cookieToken) return c.json({ error: 'No refresh token' }, 401)

  const payload = await verifyRefreshToken(cookieToken, c.env.JWT_SECRET)
  if (!payload) return c.json({ error: 'Invalid or expired refresh token' }, 401)

  if (await isRefreshTokenRevoked(c.env, payload.jti)) {
    return c.json({ error: 'Refresh token revoked' }, 401)
  }

  const T = tables(c.env)
  const user = await c.env.DB.prepare(`SELECT * FROM ${T.users} WHERE id = ?1`).bind(payload.sub).first<UserRow>()
  if (!user) return c.json({ error: 'User not found' }, 401)

  // Rotate refresh token
  await revokeRefreshToken(c.env, payload.jti)
  const accessToken = await createAccessToken(user.id, user.role, c.env.JWT_SECRET)
  const refreshToken = await createRefreshToken(user.id, c.env.JWT_SECRET)
  setRefreshCookie(c, refreshToken, isSecure(c.env))

  return c.json({ accessToken })
})

// ── POST /api/auth/logout ─────────────────────────────────────────────────────

auth.post('/logout', async (c) => {
  const cookieToken = getCookie(c, 'refresh_token')
  if (cookieToken) {
    const payload = await verifyRefreshToken(cookieToken, c.env.JWT_SECRET)
    if (payload) await revokeRefreshToken(c.env, payload.jti)
  }
  clearRefreshCookie(c, isSecure(c.env))
  return c.json({ message: 'Logged out' })
})

// ── POST /api/auth/forgot-password ───────────────────────────────────────────

auth.post('/forgot-password', async (c) => {
  const body = await c.req.json<{ email?: string }>().catch(() => null)
  if (!body?.email) return c.json({ error: 'email is required' }, 400)

  const email = body.email.toLowerCase().trim()
  const T = tables(c.env)
  const user = await c.env.DB.prepare(`SELECT id FROM ${T.users} WHERE email = ?1`)
    .bind(email).first<{ id: string }>()

  // Always 200 to avoid enumeration
  if (user) {
    const token = nanoid(32)
    await c.env.KV.put(KV.passwordReset(token), user.id, { expirationTtl: 3600 })
    const appName = (await getSetting(c.env, 'app_name')) ?? 'Zeta'
    await sendEmail(c.env, buildPasswordResetEmail({
      appName, appUrl: c.env.APP_URL, toEmail: email, token
    })).catch(() => {})
  }

  return c.json({ message: 'If the address exists, a reset link was sent.' })
})

// ── POST /api/auth/reset-password ────────────────────────────────────────────

auth.post('/reset-password', async (c) => {
  const body = await c.req.json<{ token?: string; password?: string }>().catch(() => null)
  if (!body?.token || !body.password) return c.json({ error: 'token and password are required' }, 400)
  if (body.password.length < 8) return c.json({ error: 'Password must be at least 8 characters' }, 400)

  const userId = await c.env.KV.get(KV.passwordReset(body.token))
  if (!userId) return c.json({ error: 'Invalid or expired reset token' }, 400)

  const T = tables(c.env)
  const hash = await hashPassword(body.password)
  await c.env.DB.prepare(`UPDATE ${T.users} SET password_hash = ?1, updated_at = ?2 WHERE id = ?3`)
    .bind(hash, now(), userId).run()
  await c.env.KV.delete(KV.passwordReset(body.token))

  c.executionCtx.waitUntil(audit(c.env, { userId, action: 'password_reset', ip: clientIp(c) }))
  return c.json({ message: 'Password updated.' })
})

// ── POST /api/auth/2fa/passkey/options ────────────────────────────────────────

auth.post('/2fa/passkey/options', async (c) => {
  const body = await c.req.json<{ pendingToken?: string }>().catch(() => null)
  if (!body?.pendingToken) return c.json({ error: 'pendingToken is required' }, 400)

  const pending = await verifyPending2faToken(body.pendingToken, c.env.JWT_SECRET)
  if (!pending) return c.json({ error: 'Invalid or expired token' }, 401)

  const T = tables(c.env)
  const credentials = await c.env.DB.prepare(
    `SELECT credential_id FROM ${T.passkey_credentials} WHERE user_id = ?1`
  ).bind(pending.sub).all<{ credential_id: string }>()

  if (credentials.results.length === 0) return c.json({ error: 'No passkeys registered' }, 400)

  const appUrl = new URL(c.env.APP_URL)
  const options = await generateAuthenticationOptions({
    rpID: appUrl.hostname,
    allowCredentials: credentials.results.map((r) => ({ id: r.credential_id })),
    userVerification: 'preferred',
  })

  await c.env.KV.put(KV.passkeyChallenge(pending.sub), options.challenge, { expirationTtl: 300 })
  return c.json(options)
})

// ── POST /api/auth/2fa/passkey/verify ─────────────────────────────────────────

auth.post('/2fa/passkey/verify', async (c) => {
  const body = await c.req.json<{ pendingToken?: string; credential?: unknown }>().catch(() => null)
  if (!body?.pendingToken || !body.credential) {
    return c.json({ error: 'pendingToken and credential are required' }, 400)
  }

  const pending = await verifyPending2faToken(body.pendingToken, c.env.JWT_SECRET)
  if (!pending) return c.json({ error: 'Invalid or expired token' }, 401)

  const expectedChallenge = await c.env.KV.get(KV.passkeyChallenge(pending.sub))
  if (!expectedChallenge) return c.json({ error: 'Challenge expired' }, 400)

  const T = tables(c.env)
  const credId = (body.credential as { id?: string }).id ?? ''
  const storedCred = await c.env.DB.prepare(
    `SELECT id, credential_id, public_key, sign_count FROM ${T.passkey_credentials} WHERE user_id = ?1 AND credential_id = ?2`
  ).bind(pending.sub, credId).first<Pick<PasskeyCredentialRow, 'id' | 'credential_id' | 'public_key' | 'sign_count'>>()

  if (!storedCred) return c.json({ error: 'Credential not found' }, 400)

  const requestOrigin = c.req.header('origin')
  const appUrl = new URL(c.env.APP_URL)
  const expectedOrigin = requestOrigin ?? c.env.APP_URL.replace(/\/$/, '')

  const verification = await verifyAuthenticationResponse({
    response: body.credential as Parameters<typeof verifyAuthenticationResponse>[0]['response'],
    expectedChallenge,
    expectedOrigin,
    expectedRPID: appUrl.hostname,
    credential: {
      id: storedCred.credential_id,
      publicKey: isoBase64URL.toBuffer(storedCred.public_key),
      counter: storedCred.sign_count,
    },
  })

  if (!verification.verified || !verification.authenticationInfo) {
    return c.json({ error: 'Verification failed' }, 400)
  }

  await c.env.KV.delete(KV.passkeyChallenge(pending.sub))
  await c.env.DB.prepare(`UPDATE ${T.passkey_credentials} SET sign_count = ?1 WHERE id = ?2`)
    .bind(verification.authenticationInfo.newCounter, storedCred.id).run()

  const user = await c.env.DB.prepare(`SELECT * FROM ${T.users} WHERE id = ?1`).bind(pending.sub).first<UserRow>()
  if (!user) return c.json({ error: 'User not found' }, 404)

  const accessToken = await createAccessToken(user.id, user.role, c.env.JWT_SECRET)
  const refreshToken = await createRefreshToken(user.id, c.env.JWT_SECRET)
  setRefreshCookie(c, refreshToken, isSecure(c.env))

  c.executionCtx.waitUntil(audit(c.env, { userId: user.id, action: 'login_2fa_passkey', ip: clientIp(c) }))
  return c.json({ accessToken, user: { id: user.id, email: user.email, name: user.name, role: user.role } })
})

export default auth
