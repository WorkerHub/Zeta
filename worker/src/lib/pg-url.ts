// Normalisation of a pasted PostgreSQL connection string (first-phase PostgreSQL targets).
//
// Only public-CA servers are supported: Cloudflare Workers verify the server certificate against
// the platform trust store and cannot be given a custom CA, so every CA-related knob is dropped
// from the URL instead of being stored and silently ignored (see the spike report behind this
// design). `channel_binding=require` is dropped for the same reason: without the server
// certificate hash the driver cannot produce the binding and refuses to connect — `prefer` (the
// driver default once the parameter is gone) is what works on Workers.
//
// Only the parameters that are meaningful to the server are kept: anything else would be sent as a
// startup parameter by the driver and rejected by the server (e.g. a provider's `pgbouncer=true`).

const ALLOWED_PARAMS = new Set(['application_name', 'options'])

const REMOVED_PARAMS = ['channel_binding', 'sslrootcert', 'sslcert', 'sslkey', 'sslnegotiation']

const MAX_URL_LENGTH = 4096

export interface NormalizedPostgresUrl {
  ok: true
  /** Canonical URL: the parameters above removed, `sslmode=require` forced. */
  url: string
  host: string
  database: string
}

export interface PostgresUrlError {
  ok: false
  /** Safe to show to the admin: never contains the pasted string or its credentials. */
  error: string
}

export type PostgresUrlResult = NormalizedPostgresUrl | PostgresUrlError

// Validates a pasted connection string and rewrites it into the exact form that is stored and
// handed to the driver. Errors are deliberately generic — the input carries the credentials.
export function normalizePostgresUrl(input: string): PostgresUrlResult {
  const raw = input.trim()
  if (!raw) return { ok: false, error: 'A PostgreSQL connection string is required.' }
  if (raw.length > MAX_URL_LENGTH) return { ok: false, error: 'The connection string is too long.' }

  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return {
      ok: false,
      error: 'That is not a valid connection URL. Paste the postgres:// URL from your provider.',
    }
  }
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    return { ok: false, error: 'Only postgres:// and postgresql:// connection strings are supported.' }
  }
  if (!parsed.hostname) return { ok: false, error: 'The connection string is missing a host.' }
  if (!parsed.username) return { ok: false, error: 'The connection string is missing a username.' }

  const kept = [...parsed.searchParams].filter(([key]) => ALLOWED_PARAMS.has(key))
  parsed.search = ''
  for (const key of REMOVED_PARAMS) parsed.searchParams.delete(key)
  for (const [key, value] of kept) parsed.searchParams.set(key, value)
  // Public-CA servers only: TLS is always on, the platform trust store always verifies.
  parsed.searchParams.set('sslmode', 'require')

  const database = decodeURIComponent(parsed.pathname.replace(/^\//, '')) || parsed.username
  return { ok: true, url: parsed.toString(), host: parsed.hostname, database }
}
