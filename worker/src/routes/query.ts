import { type Context, Hono } from 'hono'
import { appDbWriteTargetError, appInternalTables, capAppDbPermission } from '../lib/app-db-guard'
import { type QueryTarget, resolveQueryTarget } from '../lib/bindings'
import { D1HttpError, isAppDb, queryD1Http } from '../lib/d1-http'
import { now, tables } from '../lib/db'
import { beginExecution, cancelRequested, finishExecution, pruneExecutions, requestExecutionCancel } from '../lib/executions'
import { uuid } from '../lib/id'
import { translateMySql } from '../lib/mysql-compat'
import { MySqlQueryError, type MySqlSession, openMySqlSession } from '../lib/mysql-executor'
import { normalizeMySqlUrl } from '../lib/mysql-url'
import { cancelPostgresExecution, openPostgresSession, PostgresQueryError, type PostgresSession } from '../lib/pg-executor'
import { normalizePostgresUrl } from '../lib/pg-url'
import { type RunStatement, reserveRunSeq, saveRun } from '../lib/runs'
import { openSecret } from '../lib/secrets'
import { type SparkAccess, normalizeSparkAccess } from '../lib/spark-access'
import {
  CONNECT_TEST_OPEN,
  cancelSparkExecution,
  openSparkSession,
  SparkQueryError,
  type SparkErrorCode,
  type SparkOpenOptions,
  type SparkSession,
} from '../lib/spark-executor'
import {
  checkSqlAccess,
  classifySql,
  isWriteClass,
  limitReadSql,
  type Permission,
  type SqlClass,
  type SqlDialect,
} from '../lib/sql-guard'
import { requireAuth } from '../middleware/auth'
import type { DatabaseRow, Env, Variables } from '../types'

const MAX_RESULT_ROWS = 5000
const MAX_SQL_LENGTH = 100_000
// A MySQL database name is at most 64 characters; the session's chosen database is such a name.
const MAX_SESSION_DATABASE_LENGTH = 64

const query = new Hono<{ Bindings: Env; Variables: Variables }>()
query.use('*', requireAuth)

// A registered database whose target cannot be resolved (not linked to a Cloudflare database, the
// application DB, or a missing ZETA_APP_DB_ID). The detail is a deployment detail, so only admins
// get to see it.
function queryError(c: Context<{ Bindings: Env; Variables: Variables }>, detail: string) {
  if (c.get('userRole') === 'admin') return c.json({ error: `${detail} Contact the admin.` }, 500)
  console.error(`Query target error: ${detail}`)
  return c.json({ error: 'Database configuration error. Contact the admin.' }, 500)
}

type Ctx = Context<{ Bindings: Env; Variables: Variables }>

// A failure while *opening* the executor. The engines' classified errors already know how much of
// themselves may be shown (see resolveExecError) — a stopped Spark machine must not degrade into a
// generic configuration error — and Spark's `code` rides along.
function openExecutorError(c: Ctx, err: unknown): Response {
  if (err instanceof SparkQueryError || err instanceof PostgresQueryError || err instanceof MySqlQueryError) {
    const mapped = resolveExecError(c, err)
    return c.json(mapped.code ? { error: mapped.message, code: mapped.code } : { error: mapped.message }, mapped.status)
  }
  return queryError(c, err instanceof Error ? err.message : String(err))
}

// Maps an execution error to a client-safe message and HTTP status. SQL errors and rate limits are
// shown to everyone; transport/auth/config errors are deployment details shown only to admins. A
// Spark failure also carries its stable `code`, which the UI renders in the reader's language — but
// only alongside a message that may itself be shown, so a member never learns that a token was
// rejected.
type ErrorStatus = 400 | 429 | 500
type ExecError = { message: string; status: ErrorStatus; code?: SparkErrorCode }
function resolveExecError(c: Ctx, err: unknown): ExecError {
  if (err instanceof D1HttpError) {
    if (err.kind === 'sql') return { message: err.message, status: 400 }
    if (err.kind === 'rate_limit') return { message: err.message, status: 429 }
    if (c.get('userRole') === 'admin') return { message: `${err.message} Contact the admin.`, status: 500 }
    console.error(`Query execution error: ${err.message}`)
    return { message: 'Database configuration error. Contact the admin.', status: 500 }
  }
  if (err instanceof SparkQueryError) {
    if (err.kind === 'sql') return { message: err.message, status: 400, code: err.code }
    // The machine's own state is not a deployment secret: a stopped or booting machine is exactly
    // what the person running the query needs to hear (SPEC v2.6).
    if (err.kind === 'stopped' || err.kind === 'starting') {
      return { message: err.message, status: 500, code: err.code }
    }
    if (c.get('userRole') === 'admin') return { message: err.message, status: 500, code: err.code }
    console.error(`Query execution error: ${err.message}`)
    return { message: 'Database configuration error. Contact the admin.', status: 500 }
  }
  if (err instanceof PostgresQueryError || err instanceof MySqlQueryError) {
    if (err.kind === 'sql') return { message: err.message, status: 400 }
    if (c.get('userRole') === 'admin') return { message: `${err.message} Contact the admin.`, status: 500 }
    console.error(`Query execution error: ${err.message}`)
    return { message: 'Database configuration error. Contact the admin.', status: 500 }
  }
  return { message: err instanceof Error ? err.message : String(err), status: 400 }
}

// The optional notebookId a run is saved under: undefined/null = not saved, otherwise it must be
// one of the caller's notebooks. Returns an error response, null when absent, or the notebook with
// the number its run gets (see reserveRunSeq). Pass save = false when nothing will run, so no
// number is used up; `seq` is then null and nothing is saved.
async function resolveNotebook(
  c: Ctx,
  notebookId: unknown,
  save = true
): Promise<Response | { id: string; seq: number | null } | null> {
  if (notebookId === undefined || notebookId === null) return null
  if (typeof notebookId !== 'string' || !notebookId) return c.json({ error: 'Invalid notebookId' }, 400)
  const notFound = () => c.json({ error: 'Notebook not found' }, 404)
  if (save) {
    const reserved = await reserveRunSeq(c.env, notebookId, c.get('userId'))
    return reserved ? { id: notebookId, seq: reserved.seq } : notFound()
  }
  const T = tables(c.env)
  const row = await c.env.DB.prepare(`SELECT 1 FROM ${T.notebooks} WHERE id = ?1 AND user_id = ?2`)
    .bind(notebookId, c.get('userId'))
    .first()
  return row ? { id: notebookId, seq: null } : notFound()
}

interface Executed {
  results: Record<string, unknown>[]
  meta: Record<string, unknown>
  changes?: number
  truncated: boolean
}

// The engine-specific half of a request: one thing to run statements against, and a close() that
// releases it. For D1 the target is stateless over HTTP; for PostgreSQL one connection is opened
// for the request, shared by every statement of a batch and closed when the request is done; for
// MySQL one driver connection object is reused the same way (over HTTPS, so there is no socket).
interface Executor {
  run(sql: string, kind: SqlClass): Promise<Executed>
  close(): Promise<void>
}

// Runs one statement that already passed classification and the permission check over the D1 HTTP
// API. Reads are capped by the database itself: wrapped in `LIMIT MAX_RESULT_ROWS + 1` (see
// limitReadSql, SQLite dialect), the extra row only telling that the result was cut off. EXPLAIN and
// PRAGMA cannot be wrapped and are cut off here instead.
async function executeD1Statement(
  env: Env,
  target: Extract<QueryTarget, { kind: 'http' }>,
  sql: string,
  kind: SqlClass
): Promise<Executed> {
  if (isWriteClass(kind)) {
    const res = await queryD1Http(env, target.databaseId, sql)
    return { results: [], meta: res.meta, changes: res.changes, truncated: false }
  }
  const limited = limitReadSql(sql, MAX_RESULT_ROWS, 'sqlite')
  const res = await queryD1Http(env, target.databaseId, limited ?? sql)
  const rows = res.results
  const truncated = rows.length > MAX_RESULT_ROWS
  return { results: truncated ? rows.slice(0, MAX_RESULT_ROWS) : rows, meta: res.meta, truncated }
}

// Reads the sealed payload of a registry row and returns it as an object. It is decrypted here only —
// never in an API response — and the caller normalises it again, so an old row cannot smuggle in a
// dropped parameter. `fail` builds the engine's own config error.
async function readStoredPayload(
  env: Env,
  db: DatabaseRow,
  fail: (message: string) => Error
): Promise<Record<string, unknown>> {
  if (!db.connection_secret) throw fail('This database has no stored connection.')
  try {
    const stored = await openSecret(env, db.connection_secret)
    let payload: unknown
    try {
      payload = JSON.parse(stored)
    } catch {
      throw fail('The stored connection for this database is unreadable.')
    }
    if (!payload || typeof payload !== 'object') throw fail('The stored connection for this database is unreadable.')
    return payload as Record<string, unknown>
  } catch (err) {
    if (err instanceof PostgresQueryError || err instanceof MySqlQueryError || err instanceof SparkQueryError) throw err
    // A changed ENCRYPTION_KEY makes stored payloads undecryptable: a configuration problem, and
    // one the admin has to fix by saving the connection again.
    console.error(`Stored connection could not be read: ${err instanceof Error ? err.name : typeof err}`)
    throw fail('The stored connection for this database could not be read.')
  }
}

// The URL a connection-string engine keeps in its payload.
function payloadUrl(payload: Record<string, unknown>, fail: (message: string) => Error): string {
  const url = payload.url
  if (typeof url !== 'string' || !url) throw fail('The stored connection for this database is unreadable.')
  return url
}

// The open options for a Spark target: the connection check's patient budget when the caller asked for
// it, always carrying the caller's session, and this request's execution id when it has one (the
// service's job group, which a cancel addresses).
function sparkOpenOptions(
  connectTest: boolean | undefined,
  session: string | undefined,
  execution: string | undefined
): SparkOpenOptions {
  const base: SparkOpenOptions = connectTest ? { ...CONNECT_TEST_OPEN, session } : { session }
  return execution ? { ...base, execution } : base
}

// The decrypted Spark access of a registry row. Opening the executor and sending the cancel both need
// it, so both read it through here instead of unwrapping the payload twice.
async function sparkAccessFor(env: Env, db: DatabaseRow): Promise<SparkAccess> {
  const fail = (m: string) => new SparkQueryError(m, 'config', 'spark_config')
  const access = normalizeSparkAccess(await readStoredPayload(env, db, fail))
  if (!access.ok) throw new SparkQueryError(access.error, 'config', 'spark_config')
  return access.access
}

// The normalised connection string of a PostgreSQL registry row (same reasoning as sparkAccessFor).
async function postgresUrlFor(env: Env, db: DatabaseRow): Promise<string> {
  const fail = (m: string) => new PostgresQueryError(m, 'config')
  const normalized = normalizePostgresUrl(payloadUrl(await readStoredPayload(env, db, fail), fail))
  if (!normalized.ok) throw new PostgresQueryError(normalized.error, 'config')
  return normalized.url
}

// Opens the executor for one request. A connection-string target decrypts its stored payload here (the
// only place it is unwrapped), normalises it again, and proves the connection before any statement
// runs. `connectTest` asks a Spark target for the longer connection-check budget (20 s health probe,
// 120 s hard cap): the admin's test step and POST /api/query/probe use it, a query does not.
// `session` is the caller's own Spark session (their user id): the machine keeps one session per
// value, so two people querying it share neither temp views nor a lock.
// `sessionDatabase` is the database a MySQL request chose for its session (see
// resolveSessionDatabase); it overrides the registered default as the pin target of that one session
// and means nothing to the other engines, which never open a stateful session of their own.
// `execution` is this request's execution id: PostgreSQL marks its connection with it
// (application_name) and Spark turns it into a job group, which is what a cancel addresses.
// Failures throw the engine's classified error, which the routes report as a target error.
async function openExecutor(
  env: Env,
  db: DatabaseRow,
  target: QueryTarget,
  opts: {
    connectTest?: boolean
    session?: string
    sessionDatabase?: string | null
    execution?: string
  } = {}
): Promise<Executor> {
  if (target.kind === 'http') {
    return {
      run: (sql, kind) => executeD1Statement(env, target, sql, kind),
      close: async () => {},
    }
  }

  if (target.kind === 'spark') {
    const session: SparkSession = await openSparkSession(
      await sparkAccessFor(env, db),
      sparkOpenOptions(opts.connectTest, opts.session, opts.execution)
    )
    return {
      run: (sql, kind) => session.run(sql, kind, MAX_RESULT_ROWS),
      close: () => session.close(),
    }
  }

  if (target.kind === 'mysql') {
    const fail = (m: string) => new MySqlQueryError(m, 'config')
    const normalized = normalizeMySqlUrl(payloadUrl(await readStoredPayload(env, db, fail), fail))
    if (!normalized.ok) throw new MySqlQueryError(normalized.error, 'config')
    const session: MySqlSession = await openMySqlSession(normalized.url, opts.sessionDatabase)
    return {
      run: (sql, kind) => session.run(sql, kind, MAX_RESULT_ROWS),
      close: () => session.close(),
    }
  }

  const session: PostgresSession = await openPostgresSession(await postgresUrlFor(env, db), {
    applicationName: opts.execution,
  })
  return {
    run: (sql, kind) => session.run(sql, kind, MAX_RESULT_ROWS),
    close: () => session.close(),
  }
}

// Rewrites a MySQL introspection statement (SHOW TABLES, DESCRIBE, …) into its read-only
// SQLite equivalent — only for SQLite targets: a real MySQL target would take the statement as
// written, and PostgreSQL targets must never see SQLite-specific SQL. `error` is set for statements
// that are recognised but unsupported (SHOW DATABASES); `sql` is the statement to classify and
// run — the rewrite, or the caller's input unchanged.
function translate(sql: string, dialect: SqlDialect): { sql: string; error?: string } {
  if (dialect !== 'sqlite') return { sql }
  const result = translateMySql(sql)
  if (result?.type === 'error') return { sql, error: result.message }
  if (result?.type === 'sql') return { sql: result.sql }
  return { sql }
}

function dialectOf(db: DatabaseRow): SqlDialect {
  if (db.kind === 'postgres' || db.kind === 'mysql' || db.kind === 'spark') return db.kind
  return 'sqlite'
}

// The database a MySQL request asks its session to start on — a "current database" picker, sent as
// `sessionDatabase`. Only MySQL has such a choice: its endpoint keeps one server-side session per
// credentials, so without a pin each request would inherit whatever an earlier one left there (see
// lib/mysql-executor.ts). Absent, null or blank keeps the behaviour every row had before the field
// existed (pin the registered database), and the other engines refuse the field instead of ignoring
// it, so a client cannot believe it took effect when it did not.
function resolveSessionDatabase(
  db: DatabaseRow,
  raw: unknown
): { ok: true; value: string | null } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true, value: null }
  if (typeof raw !== 'string') return { ok: false, error: 'sessionDatabase must be a string' }
  const value = raw.trim()
  if (!value) return { ok: true, value: null }
  if (value.length > MAX_SESSION_DATABASE_LENGTH) return { ok: false, error: 'sessionDatabase is too long' }
  if (dialectOf(db) !== 'mysql') {
    return { ok: false, error: 'sessionDatabase is only supported for MySQL databases' }
  }
  return { ok: true, value }
}

// The app-DB guardrails for one database row, applied right after permission resolution (see
// lib/app-db-guard.ts): the effective permission is capped at write — which makes destructive
// statements fail the ordinary checkSqlAccess — and write-class statements must resolve to a
// target table outside the application's internal tables. Only D1 rows can name the application
// database, so external engines are untouched.
function applyAppDbGuards(env: Env, db: DatabaseRow, permission: Permission): Permission {
  return isAppDb(env, db.cf_database_id) ? capAppDbPermission(permission) : permission
}

// The internal-table half of the guardrail for one already-classified statement. Only call it
// when the target is the application database; returns the rejection message or null.
function appDbStatementError(env: Env, db: DatabaseRow, kind: SqlClass, sql: string): string | null {
  if (!isAppDb(env, db.cf_database_id) || !isWriteClass(kind)) return null
  return appDbWriteTargetError(sql, appInternalTables(env))
}

// ── Execution registration and cancellation ───────────────────────────────────
// Both query paths (one statement, a batch of them) take an optional `executionId` from the client and
// register it before anything runs; POST /cancel addresses that registration (see
// lib/executions.ts). Cancellation itself is engine-specific and lives in the executors: PostgreSQL
// gets a pg_cancel_backend on the session marked with this id, Spark a /cancel on this id's job
// group, and D1 and TiDB — which have no kill channel at all — only ever stop at a statement boundary.

// The client's uuid for one request: the registry key, PostgreSQL's application_name marker and
// Spark's job group. Shape-checked here so a malformed value never reaches an engine as an identifier.
const EXECUTION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// The optional executionId of a request body. Absent/null means the caller asked for nothing to be
// cancellable: the request then behaves exactly as it did before the field existed.
function resolveExecutionId(raw: unknown): { ok: true; value: string | null } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true, value: null }
  if (typeof raw !== 'string' || !EXECUTION_ID_PATTERN.test(raw.trim())) {
    return { ok: false, error: 'executionId must be a uuid' }
  }
  return { ok: true, value: raw.trim() }
}

// Registers a request that is about to run. A 409 answers the one case where two executions would
// share an id — and with it one kill address. The age-based pruning rides along, off the request's
// critical path, so a request that died without finishing cannot leave a row behind for good.
async function registerExecution(
  c: Ctx,
  exec: { id: string; userId: string; databaseId: string; kind: string }
): Promise<Response | null> {
  const registered = await beginExecution(c.env, {
    ...exec,
    // The address a kill needs: PostgreSQL's application_name marker (the id itself, unique per
    // execution). Spark is addressed by session + execution id and D1/TiDB have no address at all.
    handle: exec.kind === 'postgres' ? exec.id : null,
  })
  if (!registered.created) return c.json({ error: 'executionId is already in use' }, 409)
  c.executionCtx.waitUntil(pruneExecutions(c.env).catch(() => {}))
  return null
}

// Sends the engine-side kill for an execution that was just cancelled. Always best effort and always
// off the cancel request's critical path: the registry flag is what the running request obeys, and no
// deployment detail (URL, token, marker) may reach a response or a log line.
async function dispatchCancel(
  env: Env,
  cancel: { id: string; userId: string; databaseId: string; kind: string; handle: string | null }
): Promise<void> {
  try {
    const T = tables(env)
    const db = await env.DB.prepare(`SELECT * FROM ${T.d1_databases} WHERE id = ?1 AND is_active = 1`)
      .bind(cancel.databaseId)
      .first<DatabaseRow>()
    if (!db) return
    const resolved = resolveQueryTarget(env, db)
    if (!resolved.ok) return

    if (resolved.target.kind === 'postgres') {
      // No marker, no safe address: a pid-based kill could stop somebody else's statement.
      if (!cancel.handle) return
      await cancelPostgresExecution(await postgresUrlFor(env, db), cancel.handle)
      return
    }
    if (resolved.target.kind === 'spark') {
      await cancelSparkExecution(await sparkAccessFor(env, db), {
        session: cancel.userId,
        execution: cancel.id,
      })
    }
    // http (D1) and mysql (TiDB): no kill channel exists — the flag stops the next statement.
  } catch {
    // A registration that was deleted, a payload that no longer decrypts, a token that was rotated:
    // none of it may turn a cancel into an error for the caller.
    console.error('Execution cancel could not reach its engine')
  }
}

// ── POST /api/query ────────────────────────────────────────────────────────────

query.post('/', async (c) => {
  const body = await c.req
    .json<{
      databaseId?: string
      sql?: string
      notebookId?: unknown
      sessionDatabase?: unknown
      executionId?: unknown
    }>()
    .catch(() => null)
  if (typeof body?.databaseId !== 'string' || typeof body.sql !== 'string' || !body.sql.trim()) {
    return c.json({ error: 'databaseId and sql are required' }, 400)
  }
  if (body.sql.length > MAX_SQL_LENGTH) return c.json({ error: 'SQL is too long' }, 413)

  // The request's execution id is checked before any lookup: a malformed value is a bad request
  // whatever state the registration is in.
  const resolvedExecution = resolveExecutionId(body.executionId)
  if (!resolvedExecution.ok) return c.json({ error: resolvedExecution.error }, 400)
  const execution = resolvedExecution.value

  const userId = c.get('userId')
  const role = c.get('userRole')
  const sql = body.sql.trim()

  // Resolve database + permission first: the engine decides how the statement is translated and
  // classified (MySQL compatibility rewrites and the SQL dialect are per-target).
  const T = tables(c.env)
  const db = await c.env.DB.prepare(`SELECT * FROM ${T.d1_databases} WHERE id = ?1 AND is_active = 1`)
    .bind(body.databaseId)
    .first<DatabaseRow>()
  if (!db) return c.json({ error: 'Database not found' }, 404)

  let permission: Permission = 'read'
  if (role === 'admin') {
    permission = 'write_drop'
  } else {
    const perm = await c.env.DB.prepare(
      `SELECT permission FROM ${T.user_database_permissions} WHERE user_id = ?1 AND database_id = ?2`
    )
      .bind(userId, db.id)
      .first<{ permission: string }>()
    if (!perm) return c.json({ error: 'Access denied' }, 403)
    permission = (perm.permission as Permission) ?? 'read'
  }

  permission = applyAppDbGuards(c.env, db, permission)

  const dialect = dialectOf(db)
  const { sql: runSql, error: translateError } = translate(sql, dialect)
  if (translateError) return c.json({ error: translateError }, 400)

  const kind = classifySql(runSql, dialect)
  if (kind === 'forbidden') return c.json({ error: 'This SQL statement is not allowed.' }, 403)

  const denied = checkSqlAccess(kind, permission)
  if (denied) return c.json({ error: denied }, kind === 'multiple' || kind === 'empty' ? 400 : 403)
  const appDbDenied = appDbStatementError(c.env, db, kind, runSql)
  if (appDbDenied) return c.json({ error: appDbDenied }, 403)

  // The request's own session state is checked before the target is resolved: an unusable value is a
  // bad request whatever state the registration is in.
  const session = resolveSessionDatabase(db, body.sessionDatabase)
  if (!session.ok) return c.json({ error: session.error }, 400)

  const resolved = resolveQueryTarget(c.env, db)
  if (!resolved.ok) return queryError(c, resolved.error)

  const notebook = await resolveNotebook(c, body.notebookId)
  if (notebook instanceof Response) return notebook

  // Registered before anything opens or runs, so a cancel that arrives while the target is still
  // connecting is not lost.
  if (execution) {
    const taken = await registerExecution(c, { id: execution, userId, databaseId: db.id, kind: db.kind ?? 'sqlite' })
    if (taken) return taken
  }

  const executedAt = Date.now()
  let executor: Executor
  try {
    executor = await openExecutor(c.env, db, resolved.target, {
      session: userId,
      sessionDatabase: session.value,
      execution: execution ?? undefined,
    })
  } catch (err) {
    if (execution) await finishExecution(c.env, execution, 'error')
    return openExecutorError(c, err)
  }

  let cancelled = false
  let failed = false
  try {
    let result: Executed | null = null
    let errorMsg: string | null = null
    let errorStatus: ErrorStatus = 400
    let errorCode: SparkErrorCode | undefined

    if (execution && (await cancelRequested(c.env, execution))) {
      // Cancelled while the request was still opening its target: the statement is not started.
      cancelled = true
    } else {
      try {
        result = await executor.run(runSql, kind)
      } catch (err) {
        // A cancelled statement's failure text is not evidence of a mistake — Spark answers a killed
        // job with its ordinary 200 + error stack and PostgreSQL with 57014 — so the registry row,
        // not the message, decides what happened (spike #27 §10.2).
        if (execution && (await cancelRequested(c.env, execution))) {
          cancelled = true
        } else {
          const mapped = resolveExecError(c, err)
          errorMsg = mapped.message
          errorStatus = mapped.status
          errorCode = mapped.code
          failed = true
        }
      }
    }

    const duration = Date.now() - executedAt
    const rowCount = result ? (result.changes ?? result.results.length) : 0

    // Save history (non-blocking)
    c.executionCtx.waitUntil(
      c.env.DB.prepare(
        `INSERT INTO ${T.query_history} (id, user_id, database_id, sql, duration_ms, row_count, error, executed_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`
      )
        .bind(uuid(), userId, db.id, sql, duration, rowCount, errorMsg, now())
        .run()
    )

    // Save the run under its notebook (non-blocking)
    let run: { run_id: string; executed_at: number; seq: number } | null = null
    if (notebook?.seq != null) {
      const statement: RunStatement = { sql, results: result?.results ?? [], duration_ms: duration }
      if (result?.changes !== undefined) statement.changes = result.changes
      if (result?.truncated) statement.truncated = true
      if (cancelled) statement.cancelled = true
      if (errorMsg) statement.error = errorMsg
      run = { run_id: uuid(), executed_at: executedAt, seq: notebook.seq }
      c.executionCtx.waitUntil(
        saveRun(c.env, {
          id: run.run_id,
          seq: notebook.seq,
          notebookId: notebook.id,
          userId,
          databaseId: db.id,
          sql,
          statements: [statement],
          statementCount: 1,
          // One statement is the whole request: it can fail, but there is nothing after it to skip.
          halted: false,
          cancelled,
          durationMs: duration,
          executedAt,
        })
      )
    }

    // A cancellation is not an error and carries no result: the statement either never started or
    // was stopped mid-flight.
    if (cancelled) {
      return c.json({ cancelled: true, results: [], duration_ms: duration, ...run })
    }

    // A Spark failure also names its code, so the UI can render the sentence in the reader's language
    // (SPEC v2.6). A batch's per-statement entries stay plain text.
    if (errorMsg || !result) {
      const body = errorCode ? { error: errorMsg, code: errorCode, ...run } : { error: errorMsg, ...run }
      return c.json(body, errorStatus)
    }
    const payload = isWriteClass(kind)
      ? { meta: result.meta, results: [] }
      : { results: result.results, meta: result.meta, truncated: result.truncated }
    return c.json({ ...payload, duration_ms: duration, cancelled: false, ...run })
  } finally {
    await executor.close()
    if (execution) {
      await finishExecution(c.env, execution, cancelled ? 'cancelled' : failed ? 'error' : 'ok')
    }
  }
})

// ── POST /api/query/batch ─────────────────────────────────────────────────────

query.post('/batch', async (c) => {
  const body = await c.req
    .json<{
      databaseId?: string
      statements?: string[]
      notebookId?: unknown
      sessionDatabase?: unknown
      executionId?: unknown
    }>()
    .catch(() => null)
  if (
    typeof body?.databaseId !== 'string' ||
    !Array.isArray(body.statements) ||
    body.statements.length === 0 ||
    body.statements.some((x) => typeof x !== 'string')
  ) {
    return c.json({ error: 'databaseId and a non-empty statements array are required' }, 400)
  }
  if (body.statements.some((x) => x.length > MAX_SQL_LENGTH)) return c.json({ error: 'SQL is too long' }, 413)
  if (body.statements.length > 100) {
    return c.json({ error: 'Maximum 100 statements per batch' }, 400)
  }

  // Checked before any lookup, exactly like the single-statement path.
  const resolvedExecution = resolveExecutionId(body.executionId)
  if (!resolvedExecution.ok) return c.json({ error: resolvedExecution.error }, 400)
  const execution = resolvedExecution.value

  const userId = c.get('userId')
  const role = c.get('userRole')
  const T = tables(c.env)

  // Resolve database
  const db = await c.env.DB.prepare(`SELECT * FROM ${T.d1_databases} WHERE id = ?1 AND is_active = 1`)
    .bind(body.databaseId)
    .first<DatabaseRow>()
  if (!db) return c.json({ error: 'Database not found' }, 404)

  // Check permission once
  let permission: Permission = 'read'
  if (role === 'admin') {
    permission = 'write_drop'
  } else {
    const perm = await c.env.DB.prepare(
      `SELECT permission FROM ${T.user_database_permissions} WHERE user_id = ?1 AND database_id = ?2`
    )
      .bind(userId, db.id)
      .first<{ permission: string }>()
    if (!perm) return c.json({ error: 'Access denied' }, 403)
    permission = (perm.permission as Permission) ?? 'read'
  }

  permission = applyAppDbGuards(c.env, db, permission)

  const dialect = dialectOf(db)

  // Refuse a session database this target cannot use before a run number is used up or a connection
  // is opened, exactly like a rejected statement set.
  const session = resolveSessionDatabase(db, body.sessionDatabase)
  if (!session.ok) return c.json({ error: session.error }, 400)

  // Resolve the execution target (D1 HTTP API or one PostgreSQL connection for the whole batch)
  const resolved = resolveQueryTarget(c.env, db)
  if (!resolved.ok) return queryError(c, resolved.error)

  // A batch whose statements are all rejected before running is not saved, like a rejected single
  // one, and uses up no run number — and must not open a connection either. Rejections by the
  // app-DB guardrail count as rejected-before-running too, so the same predicate is used here and
  // in the loop below.
  const statementDenied = (sql: string): string | null => {
    const translated = translate(sql, dialect)
    if (translated.error) return translated.error
    const kind = classifySql(translated.sql, dialect)
    const denied = checkSqlAccess(kind, permission)
    if (denied) return denied
    return appDbStatementError(c.env, db, kind, translated.sql)
  }
  const runsAny = body.statements.some((x) => {
    const sql = x.trim()
    if (!sql) return false
    return statementDenied(sql) === null
  })
  const notebook = await resolveNotebook(c, body.notebookId, runsAny)
  if (notebook instanceof Response) return notebook

  // Registered before the target opens (see the single-statement path).
  if (execution) {
    const taken = await registerExecution(c, { id: execution, userId, databaseId: db.id, kind: db.kind ?? 'sqlite' })
    if (taken) return taken
  }

  const executedAt = Date.now()

  let executor: Executor
  try {
    executor = await openExecutor(c.env, db, resolved.target, {
      session: userId,
      sessionDatabase: session.value,
      execution: execution ?? undefined,
    })
  } catch (err) {
    if (execution) await finishExecution(c.env, execution, 'error')
    return openExecutorError(c, err)
  }

  let cancelled = false
  let failed = false
  try {
    // Run the statements in order and stop at the first failure, or at the first cancellation: a
    // statement that is rejected before it runs, or that fails while running, ends the batch with its
    // own result kept. Nothing after it runs — the remaining SQL usually depends on what just failed,
    // and continuing would act on a half-finished notebook. `halted` reports an early stop caused by a
    // failure, `cancelled` one caused by POST /api/query/cancel; a batch that runs to the end answers
    // both false. A cancelled statement carries no `error`, so the two never overlap.
    const results: RunStatement[] = []
    let halted = false
    // The statements the request asked to run, counted up front: a halted batch saves fewer
    // statements than this, and the difference is what the failure skipped (the client reports it as
    // "n more statements not run"). Blank lines never run, so they are not counted.
    const statementCount = body.statements.filter((x) => x.trim()).length

    for (const rawSql of body.statements) {
      const sql = rawSql.trim()
      if (!sql) continue

      // The statement boundary is where a cancellation takes effect for every engine: what has not
      // started yet never will, and gets no entry — exactly like the statements a halt skips.
      if (execution && (await cancelRequested(c.env, execution))) {
        cancelled = true
        break
      }

      const { sql: runSql, error: translateError } = translate(sql, dialect)
      if (translateError) {
        results.push({ sql, results: [], duration_ms: 0, error: translateError })
        halted = true
        break
      }

      const kind = classifySql(runSql, dialect)
      const denied = checkSqlAccess(kind, permission)
      if (denied) {
        results.push({ sql, results: [], duration_ms: 0, error: denied })
        halted = true
        break
      }
      const appDbDenied = appDbStatementError(c.env, db, kind, runSql)
      if (appDbDenied) {
        results.push({ sql, results: [], duration_ms: 0, error: appDbDenied })
        halted = true
        break
      }

      const start = Date.now()
      let stmtResult: Record<string, unknown>[] = []
      let changes: number | undefined
      let errorMsg: string | undefined
      let truncated = false

      try {
        const executed = await executor.run(runSql, kind)
        stmtResult = executed.results
        changes = executed.changes
        truncated = executed.truncated
      } catch (err) {
        // Same reasoning as the single-statement path: the registry row decides whether this was a
        // cancellation or a failure, never the engine's message.
        if (execution && (await cancelRequested(c.env, execution))) cancelled = true
        else errorMsg = resolveExecError(c, err).message
      }

      const duration = Date.now() - start
      const rowCount = errorMsg ? 0 : changes !== undefined ? changes : stmtResult.length

      // Save to history (non-blocking)
      c.executionCtx.waitUntil(
        c.env.DB.prepare(
          `INSERT INTO ${T.query_history} (id, user_id, database_id, sql, duration_ms, row_count, error, executed_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`
        )
          .bind(uuid(), userId, db.id, sql, duration, rowCount, errorMsg ?? null, now())
          .run()
      )

      const entry: (typeof results)[number] = { sql, results: stmtResult, duration_ms: duration }
      if (changes !== undefined) entry.changes = changes
      if (errorMsg) entry.error = errorMsg
      if (truncated) entry.truncated = true
      if (cancelled) entry.cancelled = true
      results.push(entry)

      // A cancelled statement is the batch's last entry, like a failing one.
      if (cancelled) break

      // The statement failed: its result (with the error) is the batch's last entry.
      if (errorMsg) {
        halted = true
        failed = true
        break
      }
    }

    // Save the run under its notebook (non-blocking)
    if (notebook?.seq != null) {
      const runId = uuid()
      c.executionCtx.waitUntil(
        saveRun(c.env, {
          id: runId,
          seq: notebook.seq,
          notebookId: notebook.id,
          userId,
          databaseId: db.id,
          sql: results.map((r) => r.sql).join(';\n'),
          statements: results,
          statementCount,
          halted,
          cancelled,
          durationMs: Date.now() - executedAt,
          executedAt,
        })
      )
      return c.json({ results, halted, cancelled, run_id: runId, executed_at: executedAt, seq: notebook.seq })
    }

    return c.json({ results, halted, cancelled })
  } finally {
    await executor.close()
    if (execution) {
      await finishExecution(c.env, execution, cancelled ? 'cancelled' : failed ? 'error' : 'ok')
    }
  }
})

// ── POST /api/query/cancel ────────────────────────────────────────────────────

// Stops an execution that is still running. Only the person who started it can cancel it — the
// registry's conditional UPDATE carries the user_id, so an admin is no exception and another user's
// execution is indistinguishable from one that does not exist (404, no enumeration).
//
// `cancelled: true` means a cancellation is in effect for that execution (now or from an earlier
// call), `cancelled: false` that it had already finished and there was nothing to stop. The engine-side
// kill (PostgreSQL, Spark) is dispatched after the answer, best effort: the flag is what the running
// request obeys, and a repeated cancel must not send a second kill.
query.post('/cancel', async (c) => {
  const body = await c.req.json<{ executionId?: unknown }>().catch(() => null)
  const resolved = resolveExecutionId(body?.executionId)
  if (!resolved.ok || !resolved.value) return c.json({ error: 'executionId is required' }, 400)

  const cancel = await requestExecutionCancel(c.env, resolved.value, c.get('userId'))
  if (!cancel.found) return c.json({ error: 'Execution not found' }, 404)
  if (cancel.state === 'finished') return c.json({ ok: true, cancelled: false })

  if (cancel.dispatched) {
    c.executionCtx.waitUntil(
      dispatchCancel(c.env, {
        id: resolved.value,
        userId: cancel.userId,
        databaseId: cancel.databaseId,
        kind: cancel.kind,
        handle: cancel.handle,
      })
    )
  }
  return c.json({ ok: true, cancelled: true })
})

// ── POST /api/query/probe ─────────────────────────────────────────────────────

// Whether a registered target is reachable *right now*, for the "connection" button: it opens the
// target exactly as a query would and runs one throwaway statement, then closes. It writes no history
// row and uses up no notebook run number. A D1 target is reached over Cloudflare's API rather than a
// machine that boots, so there is no state to probe and no request is made at all.
query.post('/probe', async (c) => {
  const body = await c.req.json<{ databaseId?: unknown }>().catch(() => null)
  if (typeof body?.databaseId !== 'string' || !body.databaseId) {
    return c.json({ error: 'databaseId is required' }, 400)
  }

  const userId = c.get('userId')
  const role = c.get('userRole')
  const T = tables(c.env)
  const db = await c.env.DB.prepare(`SELECT * FROM ${T.d1_databases} WHERE id = ?1 AND is_active = 1`)
    .bind(body.databaseId)
    .first<DatabaseRow>()
  if (!db) return c.json({ error: 'Database not found' }, 404)

  // The same access rule as a query: an admin, or a stored permission row.
  if (role !== 'admin') {
    const perm = await c.env.DB.prepare(
      `SELECT permission FROM ${T.user_database_permissions} WHERE user_id = ?1 AND database_id = ?2`
    )
      .bind(userId, db.id)
      .first<{ permission: string }>()
    if (!perm) return c.json({ error: 'Access denied' }, 403)
  }

  const kind = db.kind ?? 'sqlite'
  if (kind === 'sqlite') return c.json({ ok: true, kind, latency_ms: 0 })

  const started = Date.now()
  const resolved = resolveQueryTarget(c.env, db)
  if (!resolved.ok) return queryError(c, resolved.error)

  let executor: Executor
  try {
    // The connection-check budget: a Spark machine that is still booting (~17 s) still tests green,
    // which is exactly what the query path must not wait for. The caller's session rides along, so the
    // probe proves the session that caller's queries will use.
    executor = await openExecutor(c.env, db, resolved.target, { connectTest: true, session: userId })
  } catch (err) {
    return openExecutorError(c, err)
  }

  try {
    await executor.run('select 1', 'read')
    return c.json({ ok: true, kind, latency_ms: Date.now() - started })
  } catch (err) {
    const mapped = resolveExecError(c, err)
    return c.json(mapped.code ? { error: mapped.message, code: mapped.code } : { error: mapped.message }, mapped.status)
  } finally {
    await executor.close()
  }
})

// ── GET /api/query/history ────────────────────────────────────────────────────

query.get('/history', async (c) => {
  const userId = c.get('userId')
  const role = c.get('userRole')
  const limit = Math.min(Math.max(parseInt(c.req.query('limit') ?? '50', 10) || 50, 1), 200)
  const offset = Math.max(parseInt(c.req.query('offset') ?? '0', 10) || 0, 0)
  const dbId = c.req.query('databaseId')
  const T = tables(c.env)

  let rows: D1Result<Record<string, unknown>>
  if (dbId) {
    if (role === 'admin') {
      rows = await c.env.DB.prepare(
        `SELECT * FROM ${T.query_history} WHERE database_id = ?1 ORDER BY executed_at DESC LIMIT ?2 OFFSET ?3`
      )
        .bind(dbId, limit, offset)
        .all()
    } else {
      rows = await c.env.DB.prepare(
        `SELECT * FROM ${T.query_history} WHERE user_id = ?1 AND database_id = ?2 ORDER BY executed_at DESC LIMIT ?3 OFFSET ?4`
      )
        .bind(userId, dbId, limit, offset)
        .all()
    }
  } else {
    if (role === 'admin') {
      rows = await c.env.DB.prepare(`SELECT * FROM ${T.query_history} ORDER BY executed_at DESC LIMIT ?1 OFFSET ?2`)
        .bind(limit, offset)
        .all()
    } else {
      rows = await c.env.DB.prepare(
        `SELECT * FROM ${T.query_history} WHERE user_id = ?1 ORDER BY executed_at DESC LIMIT ?2 OFFSET ?3`
      )
        .bind(userId, limit, offset)
        .all()
    }
  }

  return c.json({ results: rows.results })
})

export default query
