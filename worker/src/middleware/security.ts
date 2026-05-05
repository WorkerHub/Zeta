import type { MiddlewareHandler } from 'hono'
import type { Env, Variables } from '../types'

export const securityHeaders: MiddlewareHandler<{ Bindings: Env; Variables: Variables }> =
  async (c, next) => {
    await next()
    c.header('X-Content-Type-Options', 'nosniff')
    c.header('X-Frame-Options', 'DENY')
    c.header('Referrer-Policy', 'strict-origin-when-cross-origin')
    c.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
    c.header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'")
    if (c.env.APP_URL?.startsWith('https')) {
      c.header('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload')
    }
  }
