import type { Env } from '../types'
import { openSecret } from './secrets'

// ── Spark access payload (third-phase SparkSQL targets) ────────────────────────────────────────
// A Spark target is not a connection string: the machine is reached through a published port that
// checks two tokens — the platform one (`Authorization: Bearer`, verified by the publish proxy) and
// the application one (`X-Auth-Token`, verified by the service behind it). Neither may ride in the
// URL: the proxy accepts `?_token=`, and a URL is kept in query history, logs and error messages.
//
// Validation lives here, in one place, for both paths that see a payload: the admin registration
// (which seals the normalised result) and the query path (which unseals it and normalises it again),
// so an old or hand-edited row can never smuggle in a different shape.

export interface SparkAccess {
  /** `https://host[:port][/path]` — no query string, no fragment, no trailing slash. */
  url: string
  platform_token: string
  app_token: string
  ui_url?: string
  ui_platform_token?: string
}

export interface SparkAccessOk {
  ok: true
  access: SparkAccess
  /** The publish host, used as the registration's default display name. */
  host: string
}

export interface SparkAccessError {
  ok: false
  /** Safe to show: it names the rule that failed, never the URL or a token. */
  error: string
}

export type SparkAccessResult = SparkAccessOk | SparkAccessError

const MAX_URL_LENGTH = 2048

const MAX_TOKEN_LENGTH = 4096

// A token travels as an HTTP header value: any whitespace or C0/DEL control character would break the
// request, and a line break would let a stored token inject headers of its own.
function hasUnsendableCharacter(value: string): boolean {
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0
    if (/\s/.test(ch) || code < 0x20 || code === 0x7f) return true
  }
  return false
}

// Query parameters that carry an address token. A published port accepts `?_token=`, so a pasted
// address may still hold one — it would then be stored, logged and echoed back. The tokens are
// entered as their own fields instead.
const URL_TOKEN_PARAMETERS = new Set(['_token', 'token', 'access_token'])

function readToken(value: unknown, label: string): { ok: true; token: string } | { ok: false; error: string } {
  if (typeof value !== 'string' || !value.trim()) return { ok: false, error: `The ${label} is required.` }
  const token = value.trim()
  if (token.length > MAX_TOKEN_LENGTH) return { ok: false, error: `The ${label} is too long.` }
  if (hasUnsendableCharacter(token)) return { ok: false, error: `The ${label} must not contain spaces or line breaks.` }
  return { ok: true, token }
}

// Validates one payload — a pasted registration or a stored, unsealed one — and rewrites it into the
// exact form that is sealed and handed to the executor. Errors are deliberately generic: the input
// carries both tokens.
export function normalizeSparkAccess(input: unknown): SparkAccessResult {
  const payload = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>

  const platform = readToken(payload.platform_token, 'platform access token')
  if (!platform.ok) return platform
  const app = readToken(payload.app_token, 'application token')
  if (!app.ok) return app

  const raw = typeof payload.url === 'string' ? payload.url.trim() : ''
  if (!raw) return { ok: false, error: 'The publish URL is required.' }
  if (raw.length > MAX_URL_LENGTH) return { ok: false, error: 'The publish URL is too long.' }

  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return { ok: false, error: 'That is not a valid publish URL.' }
  }
  // The publish port is an HTTPS endpoint; anything else is not the address the service hands out.
  if (parsed.protocol !== 'https:') return { ok: false, error: 'The publish URL must start with https://.' }
  if (!parsed.hostname) return { ok: false, error: 'The publish URL is missing a host.' }
  if (parsed.username || parsed.password) {
    return {
      ok: false,
      error: 'The publish URL must not carry a username or password; the two tokens are entered as their own fields.',
    }
  }
  for (const key of parsed.searchParams.keys()) {
    if (!URL_TOKEN_PARAMETERS.has(key.toLowerCase())) continue
    return {
      ok: false,
      error:
        'The publish URL carries an address token; paste it without the ?_token= part and enter the tokens as their own fields.',
    }
  }

  // The executor appends `/health` and `/query` to this base, so the query string and fragment (which
  // a published address does not use) are dropped, and the trailing slash is removed here once
  // instead of at every call site.
  const url = `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`

  const rawUi = typeof payload.ui_url === 'string' ? payload.ui_url.trim() : ''
  const rawUiToken = typeof payload.ui_platform_token === 'string' ? payload.ui_platform_token.trim() : ''
  const hasUiUrl =
    rawUi.length > 0 || (payload.ui_url !== undefined && payload.ui_url !== null && payload.ui_url !== '')
  const hasUiToken =
    rawUiToken.length > 0 ||
    (payload.ui_platform_token !== undefined && payload.ui_platform_token !== null && payload.ui_platform_token !== '')

  if (hasUiUrl !== hasUiToken) {
    return {
      ok: false,
      error: 'The Spark UI publish URL and platform token must both be provided or both omitted.',
    }
  }

  let ui_url: string | undefined
  let ui_platform_token: string | undefined

  if (hasUiUrl && hasUiToken) {
    const uiPlatform = readToken(payload.ui_platform_token, 'Spark UI platform token')
    if (!uiPlatform.ok) return uiPlatform

    if (rawUi.length > MAX_URL_LENGTH) return { ok: false, error: 'The Spark UI publish URL is too long.' }

    let parsedUi: URL
    try {
      parsedUi = new URL(rawUi)
    } catch {
      return { ok: false, error: 'That is not a valid Spark UI publish URL.' }
    }
    if (parsedUi.protocol !== 'https:') {
      return { ok: false, error: 'The Spark UI publish URL must start with https://.' }
    }
    if (!parsedUi.hostname) return { ok: false, error: 'The Spark UI publish URL is missing a host.' }
    if (parsedUi.username || parsedUi.password) {
      return {
        ok: false,
        error:
          'The Spark UI publish URL must not carry a username or password; the two tokens are entered as their own fields.',
      }
    }
    for (const key of parsedUi.searchParams.keys()) {
      if (!URL_TOKEN_PARAMETERS.has(key.toLowerCase())) continue
      return {
        ok: false,
        error:
          'The Spark UI publish URL carries an address token; paste it without the ?_token= part and enter the tokens as their own fields.',
      }
    }
    ui_url = `${parsedUi.origin}${parsedUi.pathname.replace(/\/+$/, '')}`
    ui_platform_token = uiPlatform.token
  }

  return {
    ok: true,
    access: {
      url,
      platform_token: platform.token,
      app_token: app.token,
      ...(ui_url && ui_platform_token ? { ui_url, ui_platform_token } : {}),
    },
    host: parsed.hostname,
  }
}

export function hasSparkUi(access: unknown): boolean {
  if (!access || typeof access !== 'object') return false
  const a = access as Record<string, unknown>
  return (
    typeof a.ui_url === 'string' &&
    a.ui_url.length > 0 &&
    typeof a.ui_platform_token === 'string' &&
    a.ui_platform_token.length > 0
  )
}

export async function checkDatabaseHasSparkUi(
  env: Env,
  row: { kind?: string | null; connection_secret?: string | null }
): Promise<boolean> {
  if (row.kind !== 'spark' || !row.connection_secret) return false
  try {
    const raw = await openSecret(env, row.connection_secret)
    const payload = JSON.parse(raw)
    return hasSparkUi(payload)
  } catch {
    return false
  }
}
