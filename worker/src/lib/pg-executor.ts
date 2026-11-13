import { toJsonSafeRows } from './json-safe'
import { isWriteClass, limitReadSql, type SqlClass } from './sql-guard'

// ── PostgreSQL executor (first-phase PostgreSQL targets) ──────────────────────────────────────
// One connection per /api/query request (a batch reuses it for every statement in order); it is
// closed by the caller when the request is done. There is deliberately no pool or long-lived
// cache: Workers requests do not share memory, and the target free tiers run their own poolers.
//
// The driver (postgres.js) is imported dynamically so this module stays cheap to load on the D1
// paths, which are the vast majority of requests.

export type PostgresErrorKind = 'sql' | 'auth' | 'config' | 'transport'

// A failure that already carries a caller-safe classification:
//   sql       → the statement was rejected by the server (show it, HTTP 400)
//   auth      → credentials/database were rejected (deployment detail, HTTP 500 for members)
//   config    → the stored connection cannot be used as configured (deployment detail)
//   transport → could not reach the server, TLS failed, timed out (deployment detail)
export class PostgresQueryError extends Error {
  constructor(
    message: string,
    public readonly kind: PostgresErrorKind
  ) {
    super(message)
    this.name = 'PostgresQueryError'
  }
}

export interface PostgresExecuted {
  results: Record<string, unknown>[]
  meta: Record<string, unknown>
  changes?: number
  truncated: boolean
}

export interface PostgresSession {
  run(sql: string, kind: SqlClass, maxRows: number): Promise<PostgresExecuted>
  close(): Promise<void>
}

const CONNECT_TIMEOUT_SECONDS = 15

// The application_name a cancel connection opens with. It is deliberately not the marker of any
// execution, so a cancel can never address (and cancel) its own statement. Cancelling is therefore
// denied to a statement that could not be told apart from this one: only a marker ever addresses a
// connection here.
export const CANCEL_APPLICATION_NAME = 'zeta-cancel'

// How long one cancel may take, end to end. The cancel endpoint answers as soon as the flag is set
// (the kill runs off its critical path), so a dead or unreachable target must not hold a
// connection open for the executor's connect timeout.
const CANCEL_TIMEOUT_MS = 5_000

// Never echo the pasted connection string back to a caller or into a log: a connection error can
// carry it verbatim, and it holds the credentials.
function redact(message: string, url: string): string {
  return url ? message.split(url).join('[redacted]') : message
}

// Maps a driver/driver-adjacent error to a classified, readable one. `connect` means the request
// never got as far as running SQL, so anything there is a configuration problem, not a SQL error.
export function describePostgresError(err: unknown, url = '', connect = false): PostgresQueryError {
  if (err instanceof PostgresQueryError) return err
  const code = typeof (err as { code?: unknown } | null)?.code === 'string' ? (err as { code: string }).code : ''
  const raw = err instanceof Error ? err.message : String(err)
  const message = redact(raw, url)
  const lower = raw.toLowerCase()
  const timedOut = lower.includes('timeout') || lower.includes('timed out')
  const tls = /tls|handshake|certificate|ssl/i.test(raw)

  if (code.startsWith('28')) return new PostgresQueryError(`Authentication failed: ${message}`, 'auth')
  if (code === '3D000') return new PostgresQueryError(`The database does not exist: ${message}`, 'config')
  if (
    connect ||
    code.startsWith('08') ||
    timedOut ||
    tls ||
    ['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT'].includes(code)
  ) {
    return new PostgresQueryError(`Could not connect to the database: ${message}`, 'transport')
  }
  return new PostgresQueryError(message, 'sql')
}

// Opens one connection and proves it works before the caller runs anything, so a bad host or
// credential surfaces once per request instead of once per statement. `applicationName` marks this
// connection's backend with the request's execution id — the only address a cancel can use safely
// on a pooled endpoint (see cancelPostgresExecution).
export async function openPostgresSession(
  url: string,
  opts: { applicationName?: string } = {}
): Promise<PostgresSession> {
  const { default: postgres } = await import('postgres')
  let sql: ReturnType<typeof postgres> | undefined
  try {
    sql = postgres(url, {
      // Public-CA servers only: the platform trust store verifies, no custom CA is injected.
      ssl: 'require',
      // Pooled endpoints (Neon's -pooler, pgbouncer) cannot keep session-level prepared statements.
      prepare: false,
      max: 1,
      connect_timeout: CONNECT_TIMEOUT_SECONDS,
      // Never produce a channel binding: Workers cannot hash the server certificate (see pg-url.ts).
      channel_binding: 'prefer',
      onnotice: () => {},
      // Sent as a startup parameter, so it survives a pooled endpoint attaching this client to a
      // backend. Omitted entirely when the request has no execution id.
      connection: opts.applicationName ? { application_name: opts.applicationName } : undefined,
    })
    await sql.unsafe('select 1')
  } catch (err) {
    await sql?.end({ timeout: 1 }).catch(() => {})
    throw describePostgresError(err, url, true)
  }

  let closed = false
  return {
    async run(statement: string, kind: SqlClass, maxRows: number): Promise<PostgresExecuted> {
      if (isWriteClass(kind)) {
        try {
          const result = await sql.unsafe(statement)
          const changes = typeof result.count === 'number' ? result.count : 0
          // A write's result table is not returned (same contract as the D1 path); RETURNING rows
          // are deliberately dropped there too.
          return { results: [], meta: { changes }, changes, truncated: false }
        } catch (err) {
          throw describePostgresError(err, url)
        }
      }

      const limited = limitReadSql(statement, maxRows, 'postgres') ?? statement
      let rows: Record<string, unknown>[]
      try {
        rows = (await sql.unsafe(limited)) as unknown as Record<string, unknown>[]
      } catch (err) {
        throw describePostgresError(err, url)
      }
      const truncated = rows.length > maxRows
      return {
        results: toJsonSafeRows(truncated ? rows.slice(0, maxRows) : rows),
        meta: {},
        truncated,
      }
    },

    async close(): Promise<void> {
      if (closed) return
      closed = true
      await sql.end({ timeout: 5 }).catch(() => {})
    },
  }
}

// Cancels the statements of one execution: every backend whose session carries this execution's
// application_name marker has its running statement cancelled. A *marker* is the only safe address
// here — on a pooled endpoint the backend pid of a connection changes hands between statements, so a
// pid-based kill can stop another client's statement, while a marker-based kill can only miss.
//
// Returns evidence, never proof: pg_cancel_backend() also reports success for an idle backend, and a
// pooled endpoint may have no backend carrying the marker at that moment (the kill misses and the
// statement runs to completion). Whether an execution was cancelled is answered by the registry row
// (lib/executions.ts) and by the original request's own 57014, never by this value.
export async function cancelPostgresExecution(url: string, marker: string): Promise<{ killed: boolean }> {
  if (!marker) return { killed: false }

  const attempt = async (): Promise<boolean> => {
    const { default: postgres } = await import('postgres')
    const sql = postgres(url, {
      ssl: 'require',
      prepare: false,
      max: 1,
      connect_timeout: CONNECT_TIMEOUT_SECONDS,
      channel_binding: 'prefer',
      onnotice: () => {},
      connection: { application_name: CANCEL_APPLICATION_NAME },
    })
    try {
      const rows = (await sql.unsafe(
        `select pg_cancel_backend(pid) as ok from pg_stat_activity
         where application_name = $1 and pid <> pg_backend_pid() and state = 'active'`,
        [marker]
      )) as unknown as { ok: boolean | null }[]
      return rows.some((row) => row.ok === true)
    } finally {
      await sql.end({ timeout: 1 }).catch(() => {})
    }
  }

  const deadline = new Promise<boolean>((_, reject) => {
    setTimeout(() => reject(new Error('cancel timed out')), CANCEL_TIMEOUT_MS)
  })

  try {
    return { killed: await Promise.race([attempt(), deadline]) }
  } catch (err) {
    // Never echo the marker or the connection string — both are deployment internals.
    console.error(`Postgres cancel did not complete: ${err instanceof Error ? err.message : typeof err}`)
    return { killed: false }
  }
}

// Proves a connection string works, for the admin "test connection" step and right before a
// PostgreSQL row is written. Returns the server version so the admin sees something real.
export async function testPostgresConnection(url: string): Promise<{ server_version: string }> {
  const session = await openPostgresSession(url)
  try {
    const result = await session.run('show server_version', 'read', 1)
    const first = result.results[0]
    const version = first ? String(Object.values(first)[0] ?? '') : ''
    return { server_version: version }
  } finally {
    await session.close()
  }
}
