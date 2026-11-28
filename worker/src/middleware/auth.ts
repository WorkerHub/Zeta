import type { Context, MiddlewareHandler } from 'hono'
import { getCookie } from 'hono/cookie'
import type { Env, Variables } from '../types'
import { verifyAccessToken, verifySparkUiSessionToken } from '../lib/auth'
import { KV } from '../lib/kv'

type Ctx = Context<{ Bindings: Env; Variables: Variables }>

// Returns the verified payload, or null if the token is invalid or was issued before the
// user's sessions were invalidated (password/role/email change, deletion).
async function authenticate(c: Ctx) {
  const isSparkUi = c.req.path.startsWith('/spark-ui')
  if (isSparkUi) {
    const cookie = getCookie(c, 'spark_ui_session')
    if (cookie) {
      const session = await verifySparkUiSessionToken(cookie, c.env)
      if (session) {
        const invalidatedAt = await c.env.KV.get(KV.sessionInvalidatedAt(session.sub))
        if (!invalidatedAt || session.iat > parseInt(invalidatedAt, 10)) {
          return {
            sub: session.sub,
            role: session.role,
            iat: session.iat,
            exp: session.exp,
            type: 'access' as const,
            jti: session.jti,
          }
        }
      }
    }
  }

  const authHeader = c.req.header('Authorization')?.replace(/^Bearer\s+/i, '')
  // ?token= is ONLY accepted for the /spark-ui first hit, never on /api/* routes
  const token = authHeader || (isSparkUi ? c.req.query('token') : undefined)
  if (token) {
    const payload = await verifyAccessToken(token, c.env)
    if (!payload) return null
    const invalidatedAt = await c.env.KV.get(KV.sessionInvalidatedAt(payload.sub))
    if (invalidatedAt && payload.iat <= parseInt(invalidatedAt, 10)) return null
    return payload
  }
  return null
}

export const requireAuth: MiddlewareHandler<{ Bindings: Env; Variables: Variables }> = async (c, next) => {
  const payload = await authenticate(c)
  if (!payload) return c.json({ error: 'Unauthorized' }, 401)
  c.set('userId', payload.sub)
  c.set('userRole', payload.role)
  await next()
}

export const requireAdmin: MiddlewareHandler<{ Bindings: Env; Variables: Variables }> = async (c, next) => {
  const payload = await authenticate(c)
  if (!payload) return c.json({ error: 'Unauthorized' }, 401)
  if (payload.role !== 'admin') return c.json({ error: 'Forbidden' }, 403)
  c.set('userId', payload.sub)
  c.set('userRole', payload.role)
  await next()
}
