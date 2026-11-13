import { toJsonSafeRows } from './json-safe'
import { isWriteClass, type SqlClass } from './sql-guard'
import type { SparkAccess } from './spark-access'

// ── Spark executor (third-phase SparkSQL targets) ─────────────────────────────────────────────
// A Spark target is one published HTTPS port in front of a long-lived SparkSession (the service
// serialises on a global lock), speaking a small JSON contract:
//
//   GET  {url}/health  → {"ok":true,"sparkVersion":"3.5.3"}   (platform token only)
//   POST {url}/query   → {"columns":[…],"rows":[[…]],"rowCount":n,"truncated":bool}
//                        headers: Authorization: Bearer <platform token>, X-Auth-Token: <app token>
//                        body:    {"sql":"…","maxRows":5000,"session":"<caller id>"}
//
// There is no driver to load: Workers cannot open a Spark Connect (gRPC) or Thrift (JDBC) session,
// and the service's HTTP contract *is* the interface. So this module is a thin `fetch` client with
// the classification, retry and redaction rules of the phase-3 spike (§2.3, §2.4, §2.6).
//
// Two things the response cannot tell apart are decided here on purpose:
//   * /health proves reachability and the platform token, never the app token — the admin's
//     "test connection" step therefore also runs a statement;
//   * a stopped machine and a booting one both answer with a 5xx, and only the body's wording says
//     which. A stopped machine is not started by a visit, so it is never retried.

export type SparkErrorKind = 'sql' | 'stopped' | 'starting' | 'auth' | 'transport' | 'config'

// Stable identifiers for the four failures the UI shows with its own copy (SPEC v2.6), plus one per
// remaining class. The web app maps a code to the reader's language; the message stays the fallback.
export type SparkErrorCode =
  | 'spark_sql'
  | 'spark_stopped'
  | 'spark_not_ready'
  | 'spark_app_token'
  | 'spark_publish_token'
  | 'spark_transport'
  | 'spark_config'

// A failure that already carries a caller-safe classification:
//   sql       → the statement was rejected by Spark (show it, HTTP 400)
//   stopped   → the machine is stopped and a request will not start it (shown to everyone, 500)
//   starting  → the machine is booting or unreachable right now (shown to everyone, 500)
//   auth      → a token was rejected (deployment detail, admins only)
//   transport → no usable answer: network, timeout, non-JSON (deployment detail)
//   config    → the stored registration cannot be used as configured (deployment detail)
export class SparkQueryError extends Error {
  constructor(
    message: string,
    public readonly kind: SparkErrorKind,
    public readonly code: SparkErrorCode
  ) {
    super(message)
    this.name = 'SparkQueryError'
  }
}

// The four fixed sentences of SPEC v2.6 (English; the UI renders the reader's language from `code`).
export const SPARK_STOPPED_MESSAGE =
  'The Spark machine is stopped. An admin has to start it in Instabox before it can be queried.'
export const SPARK_STARTING_MESSAGE =
  'The Spark machine is starting or temporarily unreachable. Please try again shortly.'
export const SPARK_APP_TOKEN_MESSAGE =
  'The Spark application token was rejected. Ask an admin to check the saved registration.'
export const SPARK_PUBLISH_TOKEN_MESSAGE =
  "The publish address's access token was rejected. Ask an admin to publish it again and update the registration."

// Spark's structured exceptions carry the logical plan, which runs to several KB; runs.ts stores at
// most 2000 characters, and nothing a user reads needs more than this.
const MAX_ERROR_CHARS = 1500

// The service's ceiling for the request's `session` field. Zeta sends the caller's user id, which is
// a 36-character uuid; the check turns a wrong caller into a configuration error here instead of a
// service 400, which would be classified as a rejected statement and shown as a SQL mistake.
export const MAX_SESSION_CHARS = 128

// The caller's session as the request should carry it: blank falls back to the service's default
// session (the behaviour before the field existed), too long is a bug in this deployment.
function readSession(value: string | undefined): string | undefined {
  const session = value?.trim()
  if (!session) return undefined
  if (session.length > MAX_SESSION_CHARS) {
    throw new SparkQueryError(
      `The Spark session identifier must be at most ${MAX_SESSION_CHARS} characters.`,
      'config',
      'spark_config'
    )
  }
  return session
}

const HEALTH_ATTEMPT_TIMEOUT_MS = 10_000

/** A single statement's timeout. SPEC v2.6: 300 s, whatever the spike's earlier 60 s reading said. */
export const QUERY_TIMEOUT_MS = 300_000

/** The hard ceiling of one connection check: booting a stopped-by-suspension machine takes ~17 s. */
export const CONNECT_HARD_CAP_MS = 120_000

// How hard a health probe tries. `delays[i]` is the wait *before* attempt i, so [0, 800, 2400] fires
// immediately, then after 0.8 s and 2.4 s.
export interface SparkHealthPolicy {
  delays: number[]
  /** Stop retrying once this much time has passed (0 = exactly `delays.length` attempts). */
  budgetMs: number
}

/**
 * The query path's budget: three attempts within ~3.2 s. A query is not the place to wait for a
 * machine — the spike measured that a suspended machine wakes on the first request anyway, and a
 * booting one needs ~17 s, which is what the "please try again shortly" answer is for.
 */
export const QUERY_HEALTH: SparkHealthPolicy = { delays: [0, 800, 2400], budgetMs: 0 }

/**
 * The connection check's budget: five attempts over ~17.6 s, within the 20 s ruling, so an admin
 * testing a target whose machine is still booting gets a real answer instead of "not reachable".
 */
export const VERIFY_HEALTH: SparkHealthPolicy = { delays: [0, 800, 2400, 4800, 9600], budgetMs: 20_000 }

export interface SparkHealth {
  sparkVersion: string | null
}

export interface SparkExecuted {
  results: Record<string, unknown>[]
  meta: Record<string, unknown>
  truncated: boolean
}

export interface SparkSession {
  run(sql: string, kind: SqlClass, maxRows: number): Promise<SparkExecuted>
  close(): Promise<void>
  /** What /health reported, for the admin's "test connection" step. */
  sparkVersion: string | null
}

export interface SparkOpenOptions {
  health?: SparkHealthPolicy
  /** A deadline for opening (the health probe) plus every statement that follows it. */
  hardCapMs?: number
  statementTimeoutMs?: number
  /**
   * The caller's own session — the Zeta user id: an identifier only, never a credential. The service
   * keeps one SparkSession per value: a given session serialises its statements, different sessions
   * run in parallel, temp views and the current database stay private, and the metastore is shared.
   * Omitted → the service's default session.
   */
  session?: string
}

/** What a connection check runs with: the 20 s health budget and the 120 s hard cap, in one place. */
export const CONNECT_TEST_OPEN: SparkOpenOptions = { health: VERIFY_HEALTH, hardCapMs: CONNECT_HARD_CAP_MS }

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

// Never echo the publish URL or either token back to a caller or into a log: an endpoint error can
// quote whatever it was sent.
function sanitize(detail: string, access: SparkAccess): string {
  let out = detail
  for (const part of [access.url, access.platform_token, access.app_token]) {
    if (part) out = out.split(part).join('[redacted]')
  }
  return out.slice(0, MAX_ERROR_CHARS).trim()
}

function parseJson(text: string): unknown {
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function transportError(err: unknown, access: SparkAccess): SparkQueryError {
  if (err instanceof SparkQueryError) return err
  const raw = err instanceof Error ? err.message : String(err)
  return new SparkQueryError(
    `Could not reach the Spark machine: ${sanitize(raw, access)}`,
    'transport',
    'spark_transport'
  )
}

// The status decides first (the spike's §2.3 table): the publish proxy answers 502/503 for the
// machine itself — before the service is ever asked — so a rejection there says nothing about the
// app token, and a stopped machine even masks a wrong app token behind its 503.
function classifyFailure(
  res: Response,
  text: string,
  json: unknown,
  access: SparkAccess,
  context: 'health' | 'query'
): SparkQueryError {
  const detail = sanitize(text, access)
  const status = res.status

  if (status === 502 || status === 503) {
    // Verbatim from the spike: "Sandbox offline: it is stopped, and a visit does not start it."
    if (/is stopped|does not start it/i.test(text)) {
      return new SparkQueryError(SPARK_STOPPED_MESSAGE, 'stopped', 'spark_stopped')
    }
    return new SparkQueryError(SPARK_STARTING_MESSAGE, 'starting', 'spark_not_ready')
  }
  if (status === 401 || status === 403) {
    // /health is checked by the proxy alone, so a rejection there is always the publish address. On
    // /query the two layers differ by content type: `text/plain` is the proxy's, JSON the service's.
    const plain = (res.headers.get('content-type') ?? '').toLowerCase().includes('text/plain')
    return context === 'health' || plain
      ? new SparkQueryError(SPARK_PUBLISH_TOKEN_MESSAGE, 'auth', 'spark_publish_token')
      : new SparkQueryError(SPARK_APP_TOKEN_MESSAGE, 'auth', 'spark_app_token')
  }
  if (status === 400) {
    const message = (json as { error?: unknown } | null)?.error
    const text400 = typeof message === 'string' && message ? sanitize(message, access) : detail
    return new SparkQueryError(text400 || 'The statement was rejected by Spark.', 'sql', 'spark_sql')
  }
  return new SparkQueryError(
    `Could not reach the Spark machine: ${detail || `HTTP ${status}`}`,
    'transport',
    'spark_transport'
  )
}

async function requestHealth(access: SparkAccess, timeoutMs: number): Promise<SparkHealth> {
  // The platform token goes in the header only (the proxy also accepts `?_token=`, which no stored
  // URL may carry — see lib/spark-access.ts).
  let res: Response
  try {
    res = await fetch(`${access.url}/health`, {
      headers: { Authorization: `Bearer ${access.platform_token}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(Math.max(1, timeoutMs)),
    })
  } catch (err) {
    throw transportError(err, access)
  }
  const text = await res.text().catch(() => '')
  const json = parseJson(text)
  if (!res.ok) throw classifyFailure(res, text, json, access, 'health')
  const version = (json as { sparkVersion?: unknown } | null)?.sparkVersion
  return { sparkVersion: typeof version === 'string' && version ? version : null }
}

// Proves reachability and the platform token, retrying only the one state that changes by itself
// (a booting machine). Failures keep their classification, so the caller can answer with the fixed
// sentence and never retries a query because of them.
export async function probeSparkHealth(
  access: SparkAccess,
  policy: SparkHealthPolicy = QUERY_HEALTH,
  deadline = Number.POSITIVE_INFINITY
): Promise<SparkHealth> {
  const startedAt = Date.now()
  let last: SparkQueryError | null = null
  for (const delay of policy.delays) {
    if (policy.budgetMs > 0 && Date.now() - startedAt + delay > policy.budgetMs) break
    if (delay > 0) await sleep(delay)
    const remaining = deadline - Date.now()
    if (remaining <= 0) break
    try {
      return await requestHealth(access, Math.min(HEALTH_ATTEMPT_TIMEOUT_MS, remaining))
    } catch (err) {
      const error = err instanceof SparkQueryError ? err : transportError(err, access)
      if (error.kind !== 'starting') throw error
      last = error
    }
  }
  throw last ?? new SparkQueryError(SPARK_STARTING_MESSAGE, 'starting', 'spark_not_ready')
}

interface SparkResponse {
  columns: string[]
  rows: unknown[][]
  truncated: boolean
}

// One statement, one request: never retried. A lost response cannot tell whether the statement ran,
// so a retry could execute an INSERT twice.
async function postQuery(
  access: SparkAccess,
  statement: string,
  maxRows: number,
  timeoutMs: number,
  session?: string
): Promise<SparkResponse> {
  let res: Response
  try {
    res = await fetch(`${access.url}/query`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${access.platform_token}`,
        'X-Auth-Token': access.app_token,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      // The field is left out entirely when there is no session, so the service answers on its default
      // session exactly as it did before the field existed.
      body: JSON.stringify(session ? { sql: statement, maxRows, session } : { sql: statement, maxRows }),
      signal: AbortSignal.timeout(Math.max(1, timeoutMs)),
    })
  } catch (err) {
    throw transportError(err, access)
  }

  const text = await res.text().catch(() => '')
  const json = parseJson(text)
  if (!res.ok) throw classifyFailure(res, text, json, access, 'query')
  // Spark reports a rejected statement as 200 + {"error": "…"} — the marker is what makes a "ok"
  // response a failure.
  if (json && typeof json === 'object' && 'error' in json) {
    const message = (json as { error?: unknown }).error
    const detail = typeof message === 'string' && message ? message : text
    throw new SparkQueryError(sanitize(detail, access) || 'The statement was rejected by Spark.', 'sql', 'spark_sql')
  }
  const columns = (json as { columns?: unknown } | null)?.columns
  const rows = (json as { rows?: unknown } | null)?.rows
  if (!Array.isArray(columns) || !Array.isArray(rows)) {
    throw new SparkQueryError('The Spark service returned an unexpected response.', 'transport', 'spark_transport')
  }
  return {
    columns: columns.map((c) => String(c)),
    rows: rows.map((row) => (Array.isArray(row) ? row : [])),
    truncated: (json as { truncated?: unknown }).truncated === true,
  }
}

// Opens one session: proves the machine is reachable, then hands out its `run`. `hardCapMs` bounds
// everything that follows — the connection check needs that, a query does not.
export async function openSparkSession(access: SparkAccess, opts: SparkOpenOptions = {}): Promise<SparkSession> {
  // Read before the health probe: an unusable session is this deployment's problem, not a reason to
  // spend a request on the machine.
  const session = readSession(opts.session)
  const deadline = opts.hardCapMs ? Date.now() + opts.hardCapMs : Number.POSITIVE_INFINITY
  const health = await probeSparkHealth(access, opts.health ?? QUERY_HEALTH, deadline)
  const statementTimeout = opts.statementTimeoutMs ?? QUERY_TIMEOUT_MS

  return {
    sparkVersion: health.sparkVersion,

    async run(statement: string, kind: SqlClass, maxRows: number): Promise<SparkExecuted> {
      const remaining = deadline - Date.now()
      if (remaining <= 0) throw new SparkQueryError(SPARK_STARTING_MESSAGE, 'starting', 'spark_not_ready')
      const response = await postQuery(access, statement, maxRows, Math.min(statementTimeout, remaining), session)

      // A write's result table is not returned, and the service's rowCount is 0 for DDL/DML — an
      // affected-row count is never invented here (same contract as the D1 and PostgreSQL paths).
      if (isWriteClass(kind)) return { results: [], meta: {}, truncated: false }

      // `columns` and `rows` are separate arrays: a short row is padded with null, otherwise the
      // missing keys would disappear from the JSON and shift the UI's columns.
      const results = response.rows.map((row) => {
        const out: Record<string, unknown> = {}
        for (let i = 0; i < response.columns.length; i++) out[response.columns[i]!] = i < row.length ? row[i] : null
        return out
      })
      // No limitReadSql wrapper: the service caps at 5000 rows itself and reports `truncated`.
      return { results: toJsonSafeRows(results), meta: {}, truncated: response.truncated }
    },

    // Nothing to release: each statement is one HTTP request and the service keeps its own session.
    async close() {},
  }
}

// Proves a registration works, for the admin "test connection" step and right before a Spark row is
// written: /health for reachability and the platform token, then one statement for the app token and
// the execution path. The reported version is the one /health gave.
export async function testSparkConnection(access: SparkAccess, session?: string): Promise<{ server_version: string }> {
  // The admin's own session: the check runs the way that admin's queries will.
  const opened = await openSparkSession(access, { ...CONNECT_TEST_OPEN, session })
  try {
    await opened.run('select 1', 'read', 1)
    return { server_version: opened.sparkVersion ?? '' }
  } finally {
    await opened.close()
  }
}
