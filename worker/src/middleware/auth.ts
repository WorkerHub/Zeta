import type { Context, MiddlewareHandler } from 'hono'
import type { Env, Variables } from '../types'
import { verifyAccessToken } from '../lib/auth'
import { KV } from '../lib/kv'

type Ctx = Context<{ Bindings: Env; Variables: Variables }>

// Returns the verified payload, or null if the token is invalid or was issued before the
// user's sessions were invalidated (password/role/email change, deletion).
async function authenticate(c: Ctx) {
  const token = c.req.header('Authorization')?.replace('Bearer ', '')
  const payload = await verifyAccessToken(token, c.env.JWT_SECRET)
  if (!payload) return null
  const invalidatedAt = await c.env.KV.get(KV.sessionInvalidatedAt(payload.sub))
  if (invalidatedAt && payload.iat <= parseInt(invalidatedAt, 10)) return null
  return payload
}

export const requireAuth: MiddlewareHandler<{ Bindings: Env; Variables: Variables }> =
  async (c, next) => {
    const payload = await authenticate(c)
    if (!payload) return c.json({ error: 'Unauthorized' }, 401)
    c.set('userId', payload.sub)
    c.set('userRole', payload.role)
    await next()
  }

export const requireAdmin: MiddlewareHandler<{ Bindings: Env; Variables: Variables }> =
  async (c, next) => {
    const payload = await authenticate(c)
    if (!payload) return c.json({ error: 'Unauthorized' }, 401)
    if (payload.role !== 'admin') return c.json({ error: 'Forbidden' }, 403)
    c.set('userId', payload.sub)
    c.set('userRole', payload.role)
    await next()
  }
