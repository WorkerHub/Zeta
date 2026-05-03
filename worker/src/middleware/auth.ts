import type { MiddlewareHandler } from 'hono'
import type { Env, Variables } from '../types'
import { verifyAccessToken } from '../lib/auth'

export const requireAuth: MiddlewareHandler<{ Bindings: Env; Variables: Variables }> =
  async (c, next) => {
    const token = c.req.header('Authorization')?.replace('Bearer ', '')
    const payload = await verifyAccessToken(token, c.env.JWT_SECRET)
    if (!payload) return c.json({ error: 'Unauthorized' }, 401)
    c.set('userId', payload.sub)
    c.set('userRole', payload.role)
    await next()
  }

export const requireAdmin: MiddlewareHandler<{ Bindings: Env; Variables: Variables }> =
  async (c, next) => {
    const token = c.req.header('Authorization')?.replace('Bearer ', '')
    const payload = await verifyAccessToken(token, c.env.JWT_SECRET)
    if (!payload) return c.json({ error: 'Unauthorized' }, 401)
    if (payload.role !== 'admin') return c.json({ error: 'Forbidden' }, 403)
    c.set('userId', payload.sub)
    c.set('userRole', payload.role)
    await next()
  }
