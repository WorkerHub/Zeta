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
// credential surfaces once per request instead of once per statement.
export async function openPostgresSession(url: string): Promise<PostgresSession> {
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
