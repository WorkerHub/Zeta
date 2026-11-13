// Normalisation of a pasted MySQL connection string (second-phase MySQL targets).
//
// This kind means one thing only: TiDB Cloud Starter (the MySQL-compatible serverless offering).
// Its driver talks to TiDB Cloud's HTTPS endpoint over `fetch` — it never opens a MySQL wire
// connection — so a plain MySQL/MariaDB server is not an "unsupported target", it is not an object
// of this kind at all. The host whitelist below is what enforces that, and the wording of every
// rejection says so.
//
// Everything the driver does not read is stripped from the string that gets stored: the HTTP driver
// takes only hostname/username/password/database out of the URL, so TLS knobs (`ssl-ca`, `ssl-mode`,
// `ssl`), `charset` and any other parameter would be stored as decoration and mislead whoever reads
// the registration next.

const TIDB_HOST_SUFFIX = '.tidbcloud.com'

const ALLOWED_PROTOCOLS = new Set(['mysql:', 'mysql2:'])

const DEFAULT_DATABASE = 'test'

const DEFAULT_PORT = 4000

const MAX_URL_LENGTH = 4096

const SPECIAL_CHARACTERS_HINT =
  'If the password contains special characters such as @ : / #, percent-encode them first (for example %40 for @).'

export interface NormalizedMySqlUrl {
  ok: true
  /** Canonical URL: `mysql://`, port 4000, no parameters, database name included. */
  url: string
  host: string
  database: string
}

export interface MySqlUrlError {
  ok: false
  /** Safe to show to the admin: never contains the pasted string or its credentials. */
  error: string
}

export type MySqlUrlResult = NormalizedMySqlUrl | MySqlUrlError

// An unencoded `@` in the credentials leaves two of them in the authority part, and the URL parser
// keeps the last one as the separator — username and host come back silently mangled. The same goes
// for `/`, which ends the authority early (that one surfaces as a host outside TiDB Cloud, whose
// message carries the same hint). Detect the `@` case up front so the admin gets an actionable
// message instead of a confusing host rejection.
function hasUnencodedUserinfo(raw: string): boolean {
  const scheme = raw.indexOf('://')
  if (scheme === -1) return false
  const start = scheme + 3
  const end = raw.slice(start).search(/[/?#]/)
  const authority = end === -1 ? raw.slice(start) : raw.slice(start, start + end)
  return authority.split('@').length > 2
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function isDecodable(value: string): boolean {
  try {
    decodeURIComponent(value)
    return true
  } catch {
    return false
  }
}

// Validates a pasted connection string and rewrites it into the exact form that is stored and
// handed to the driver. Errors are deliberately generic — the input carries the credentials.
export function normalizeMySqlUrl(input: string): MySqlUrlResult {
  const raw = input.trim()
  if (!raw) return { ok: false, error: 'A MySQL connection string is required.' }
  if (raw.length > MAX_URL_LENGTH) return { ok: false, error: 'The connection string is too long.' }
  if (hasUnencodedUserinfo(raw)) return { ok: false, error: SPECIAL_CHARACTERS_HINT }

  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return {
      ok: false,
      error: 'That is not a valid connection URL. Paste the mysql:// URL from TiDB Cloud.',
    }
  }
  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    return { ok: false, error: 'Only mysql:// and mysql2:// connection strings are supported.' }
  }
  if (!parsed.hostname) return { ok: false, error: 'The connection string is missing a host.' }
  if (!parsed.username) return { ok: false, error: 'The connection string is missing a username.' }
  if (!parsed.password) return { ok: false, error: 'The connection string is missing a password.' }
  // The driver decodes both with decodeURIComponent; a stray `%` would make it throw at connect time.
  if (!isDecodable(parsed.username) || !isDecodable(parsed.password)) {
    return {
      ok: false,
      error: 'The credentials contain an invalid percent-encoding. Encode a literal % as %25.',
    }
  }

  // Public-CA servers only, and TiDB Cloud Starter only: any other host is refused here rather
  // than failing later inside the HTTP call.
  const host = parsed.hostname.toLowerCase()
  if (!host.endsWith(TIDB_HOST_SUFFIX)) {
    return {
      ok: false,
      error: `This engine supports TiDB Cloud Starter only: the host must be a *${TIDB_HOST_SUFFIX} gateway. ${SPECIAL_CHARACTERS_HINT}`,
    }
  }

  // The port never reaches the HTTP endpoint (the driver keeps just the hostname); pinning it to
  // 4000 keeps one canonical form. An empty path defaults to TiDB's `test` database.
  const path = parsed.pathname.replace(/^\//, '')
  const database = path ? safeDecode(path) : DEFAULT_DATABASE
  // `URL` keeps username/password percent-encoded as given, which is exactly what the driver
  // decodes again; the query string and fragment are dropped wholesale (see the header).
  const url = `mysql://${parsed.username}:${parsed.password}@${host}:${DEFAULT_PORT}/${path || DEFAULT_DATABASE}`

  return { ok: true, url, host, database }
}
