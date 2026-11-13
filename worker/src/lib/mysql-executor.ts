import { toJsonSafeRows } from './json-safe'
import { isWriteClass, limitReadSql, type SqlClass } from './sql-guard'

// ── MySQL executor (second-phase MySQL targets: TiDB Cloud Starter) ───────────────────────────
// The official TiDB Cloud serverless driver, called over HTTPS with `fetch` — there is no socket,
// no STARTTLS adaptation and no Hyperdrive in this path. Each request makes its own driver
// connection object and every statement of a batch runs through that one object in order; nothing
// is pooled or cached between requests (Workers requests do not share memory anyway).
//
// The executor never asks for session features: no `persist()`, no `begin()`, no `USE`/`SET` of its
// own. It cannot rely on per-request isolation either — the live re-check (2026-11-13, plan §10-7)
// showed the HTTP endpoint pins **one** server-side session per set of credentials and returns the
// same `CONNECTION_ID` to every request (even from a fresh process), so `USE`/`SET`/`BEGIN` from one
// statement would persist for every other request of the app. That is why lib/sql-guard.ts refuses
// them for this dialect instead of treating them as harmless.
//
// The driver is imported dynamically so the D1 paths (the vast majority of requests) never pay for
// loading it, exactly like the PostgreSQL executor.

export type MySqlErrorKind = 'sql' | 'auth' | 'config' | 'transport'

// A failure that already carries a caller-safe classification:
//   sql       → the statement was rejected by the server (show it, HTTP 400)
//   auth      → credentials were rejected (deployment detail, HTTP 500 for members)
//   config    → the stored connection cannot be used as configured (deployment detail)
//   transport → could not reach the endpoint, timed out, quota/rate limited (deployment detail)
export class MySqlQueryError extends Error {
  constructor(
    message: string,
    public readonly kind: MySqlErrorKind
  ) {
    super(message)
    this.name = 'MySqlQueryError'
  }
}

export interface MySqlExecuted {
  results: Record<string, unknown>[]
  meta: Record<string, unknown>
  changes?: number
  truncated: boolean
}

export interface MySqlSession {
  run(sql: string, kind: SqlClass, maxRows: number): Promise<MySqlExecuted>
  close(): Promise<void>
}

// One HTTP call to the TiDB Cloud endpoint, bounded by the platform's own timeout signal. This is
// the driver's native injection point (`config.fetch`), so the timeout needs no custom transport.
export const REQUEST_TIMEOUT_MS = 30_000

const SHORTEST_REDACTABLE = 4

// Never echo the pasted connection string back to a caller or into a log: a connection error can
// carry it verbatim, and it holds the credentials. Unlike the PostgreSQL executor this also strips
// the host, username and password on their own, because an HTTP endpoint's error text tends to name
// just one of them.
function redact(message: string, url: string): string {
  if (!url) return message
  let out = message.split(url).join('[redacted]')
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return out
  }
  const parts = [parsed.hostname, safeDecode(parsed.username), safeDecode(parsed.password)]
  for (const part of parts) {
    if (part.length < SHORTEST_REDACTABLE) continue
    out = out.split(part).join('[redacted]')
  }
  return out
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

// Live re-check (2026-11-13, TiDB Cloud Starter v8.5.3, plan §10-6): the endpoint answers **every**
// rejected statement with 400 — parser errors carry no `Error <errno>` line at all
// (`You have an error in your SQL syntax: …`), table/column/privilege errors arrive as
// `Execute SQL fail: Error 1146 (42S02): …`, unsupported statements as `Unsupported SQL …`. Credential
// and database problems both come back as 401 instead. The status therefore decides, not the wording,
// and an offline-instance `Error 1105 (HY000)` would land on 400 like any other statement error.
const UNKNOWN_DATABASE = /Error 1049 \(42000\)/

// `btoa` refuses anything outside Latin-1, which is how a credential with a non-Latin-1 character
// fails — a stored-connection problem, not a statement problem.
const UNENCODABLE_CREDENTIALS = /invalidcharactererror|latin1|latin-1|iso-8859-1/i

// Maps a driver error to a classified, readable one (plan §3.5, finalized by the live re-check).
// `connect` means the request never got as far as running SQL, so anything there is a
// configuration/transport problem.
export function describeMySqlError(err: unknown, url = '', connect = false): MySqlQueryError {
  if (err instanceof MySqlQueryError) return err
  const raw = err instanceof Error ? err.message : String(err)
  const message = redact(raw, url)
  const status =
    typeof (err as { status?: unknown } | null)?.status === 'number' ? (err as { status: number }).status : 0

  // The driver's own retry hint: the endpoint answered without a session header.
  if (/empty session/i.test(raw)) {
    return new MySqlQueryError(`The endpoint did not keep a session, try again: ${message}`, 'transport')
  }
  if (status === 401 || status === 403) {
    // Live: an unknown database also arrives as 401 (`Error 1049 (42000)`), so it must not be shown as
    // a credential problem — it is a deployment detail the admin fixes by saving the target again.
    if (UNKNOWN_DATABASE.test(raw)) {
      return new MySqlQueryError(`The database does not exist: ${message}`, 'config')
    }
    return new MySqlQueryError(`Authentication failed: ${message}`, 'auth')
  }
  // No rate-limit class exists in this API: 429 is a deployment-level detail with a quota hint.
  if (status === 429) {
    return new MySqlQueryError(`The endpoint is rate limiting or over quota: ${message}`, 'transport')
  }
  if (status >= 500 && status < 600) {
    return new MySqlQueryError(`Could not reach the database: ${message}`, 'transport')
  }
  // 400 = the server rejected this statement, whatever its wording (see the note above). Shown to
  // everyone as a 400.
  if (status === 400) return new MySqlQueryError(message, 'sql')
  if (UNENCODABLE_CREDENTIALS.test(raw)) {
    return new MySqlQueryError(`The stored credentials cannot be encoded: ${message}`, 'config')
  }
  if (connect) return new MySqlQueryError(`Could not connect to the database: ${message}`, 'transport')
  return new MySqlQueryError(message, 'sql')
}

type ExecuteResult = { rows?: unknown[] | null; rowsAffected?: number | null }

// The database the session must be pointed at, taken from the stored (normalised) URL.
function databaseOf(url: string): string | null {
  try {
    const path = new URL(url).pathname.replace(/^\//, '')
    return path ? decodeURIComponent(path) : null
  } catch {
    return null
  }
}

// The driver passes (url, { method, body, headers, cache }) to the injected fetch; the timeout is
// added on top, so a hung endpoint fails as a transport error instead of holding the request.
const timedFetch = (input: string, init: RequestInit = {}): Promise<Response> =>
  fetch(input, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })

// Opens one driver connection and proves it with a `select 1` before the caller runs anything, so a
// bad host, credential or network path surfaces once per request instead of once per statement.
// The proof also reads `database()`: the endpoint pins one session per (credentials, database) and
// reuses it for every later request, so a `USE` issued anywhere else (a CLI on the same instance,
// another tool) would leave our statements silently running against the wrong schema. That is a
// configuration problem the admin has to fix, not a query to guess about — fail closed on it.
export async function openMySqlSession(url: string): Promise<MySqlSession> {
  const { connect } = await import('@tidbcloud/serverless')
  const expected = databaseOf(url)
  let connection: ReturnType<typeof connect>
  try {
    connection = connect({
      url,
      // Workers verifies the endpoint certificate against the platform trust store; nothing to inject.
      fetch: timedFetch as unknown as NonNullable<Parameters<typeof connect>[0]['fetch']>,
    })
    const proof = (await connection.execute('select 1 as ok, database() as db', null, {
      fullResult: true,
    })) as ExecuteResult
    const actual = (proof.rows?.[0] as { db?: unknown } | undefined)?.db
    if (expected && typeof actual === 'string' && actual && actual !== expected) {
      throw new MySqlQueryError(
        `The instance's session is on database "${actual}" instead of "${expected}". Save the target again in Admin → Databases, or run USE \`${expected}\` on that instance.`,
        'config'
      )
    }
  } catch (err) {
    throw describeMySqlError(err, url, true)
  }

  return {
    async run(statement: string, kind: SqlClass, maxRows: number): Promise<MySqlExecuted> {
      if (isWriteClass(kind)) {
        let result: ExecuteResult
        try {
          result = (await connection.execute(statement, null, { fullResult: true })) as ExecuteResult
        } catch (err) {
          throw describeMySqlError(err, url)
        }
        const changes = typeof result.rowsAffected === 'number' ? result.rowsAffected : 0
        // A write's result table is not returned (same contract as the D1 and PostgreSQL paths).
        return { results: [], meta: { changes }, changes, truncated: false }
      }

      const limited = limitReadSql(statement, maxRows, 'mysql') ?? statement
      let rows: Record<string, unknown>[]
      try {
        const result = (await connection.execute(limited, null, { fullResult: true })) as ExecuteResult
        rows = (result.rows ?? []) as Record<string, unknown>[]
      } catch (err) {
        throw describeMySqlError(err, url)
      }
      const truncated = rows.length > maxRows
      return {
        results: toJsonSafeRows(truncated ? rows.slice(0, maxRows) : rows),
        meta: {},
        truncated,
      }
    },

    // Nothing to release: the HTTPS request is over once `execute` resolves, and no session state
    // was opened. The method exists so callers treat every engine the same way.
    async close(): Promise<void> {},
  }
}

// Proves a connection string works, for the admin "test connection" step and right before a MySQL
// row is written. Returns the server version so the admin sees something real.
export async function testMySqlConnection(url: string): Promise<{ server_version: string }> {
  const session = await openMySqlSession(url)
  try {
    const result = await session.run('select version()', 'read', 1)
    const first = result.results[0]
    const version = first ? String(Object.values(first)[0] ?? '') : ''
    return { server_version: version }
  } finally {
    await session.close()
  }
}
