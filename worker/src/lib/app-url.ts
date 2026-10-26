import type { Env } from '../types'

// Everything deployment-scoped hangs off one origin: email verification/reset links, the WebAuthn
// rpID and expectedOrigin, and the CORS allow-list. APP_URL stays the primary source (normalized
// exactly as before); when a deployment does not configure it, the origin is taken from the request
// the Worker is serving — so the var is optional and the site keeps working without it.
//
// Derivation reads only c.req.url on purpose: X-Forwarded-Host / X-Forwarded-Proto and friends are
// caller-controlled, so trusting them would let a request pick its own rpID/origin. There is also
// no hard-coded production fallback.
type AppUrlCtx = { env: Pick<Env, 'APP_URL'>; req: { url: string } }

// The deployment's public origin: scheme + host, never a trailing slash.
export function resolveAppOrigin(c: AppUrlCtx): string {
  const configured = c.env.APP_URL?.trim().replace(/\/$/, '')
  return configured || new URL(c.req.url).origin
}

// The WebAuthn relying-party ID is that origin's hostname.
export function resolveRpID(c: AppUrlCtx): string {
  return new URL(resolveAppOrigin(c)).hostname
}
