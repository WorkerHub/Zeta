import type { MiddlewareHandler } from 'hono'
import type { Env, Variables } from '../types'

// Secure whenever the app is configured for HTTPS *or* this request actually arrived over HTTPS,
// so a mistyped http:// APP_URL behind TLS cannot strip the refresh cookie's Secure flag or HSTS.
type SecureCtx = { env: Pick<Env, 'APP_URL'>; req: { url: string } }
export const isSecure = (c: SecureCtx) =>
  Boolean(c.env.APP_URL?.trim().startsWith('https')) || new URL(c.req.url).protocol === 'https:'

export const securityHeaders: MiddlewareHandler<{ Bindings: Env; Variables: Variables }> = async (c, next) => {
  await next()
  c.header('X-Content-Type-Options', 'nosniff')
  c.header('X-Frame-Options', 'DENY')
  c.header('Referrer-Policy', 'strict-origin-when-cross-origin')
  c.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
  c.header(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'"
  )
  if (isSecure(c)) {
    c.header('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload')
  }
}
