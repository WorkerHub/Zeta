import type { Env } from '../types'
import { tables } from './db'

// ── Saved notebook runs ───────────────────────────────────────────────────────
// Every run of a notebook (one or more statements) is stored with its results so they survive
// switching tabs, reloading and changing devices. Two limits keep the app database bounded:
// - per notebook, the newest N runs are kept: N = min(the user's own limit, the admin limit);
// - per user, the stored results add up to at most the admin's storage quota; beyond it the
//   user's oldest runs (in any notebook) are dropped.
// A single run stores at most MAX_STORED_RESULT_BYTES of results, well below D1's 2 MB row limit.

export const MAX_STORED_RESULT_BYTES = 512 * 1024
const MAX_STORED_SQL = 10_000
// Used instead when a batch's statements alone would not fit in the budget
const MIN_STORED_SQL = 500
const MAX_STORED_ERROR = 2_000
const SUMMARY_SQL_LENGTH = 1_000

export const DEFAULT_RUN_LIMIT = 100
export const MAX_RUN_LIMIT = 1_000
export const DEFAULT_RUN_QUOTA_MB = 50
export const MAX_RUN_QUOTA_MB = 1_024

export interface RunStatement {
  sql: string
  results: Record<string, unknown>[]
  duration_ms: number
  changes?: number
  truncated?: boolean
  error?: string
  // Set when only the first `stored_rows` of `results` were saved
  stored_rows?: number
}

const encoder = new TextEncoder()
const byteLength = (s: string) => encoder.encode(s).length

export interface PackedRun {
  json: string
  bytes: number
  rowCount: number
  errorCount: number
  storageTruncated: boolean
}

// Serialises a run's results within the byte budget: rows are kept in order until the budget runs
// out, and every statement that lost rows gets `stored_rows`.
export function packRunResults(statements: RunStatement[], budget = MAX_STORED_RESULT_BYTES): PackedRun {
  const skeleton = (sqlLength: number) =>
    statements.map((s) => {
      const entry: RunStatement = { sql: s.sql.slice(0, sqlLength), results: [], duration_ms: s.duration_ms }
      if (s.changes !== undefined) entry.changes = s.changes
      if (s.truncated) entry.truncated = true
      if (s.error !== undefined) entry.error = s.error.slice(0, MAX_STORED_ERROR)
      return entry
    })
  let packed = skeleton(MAX_STORED_SQL)
  // Room for the stored_rows markers that may be added below
  const markerBytes = statements.length * 20
  let used = byteLength(JSON.stringify(packed)) + markerBytes
  if (used > budget) {
    packed = skeleton(MIN_STORED_SQL)
    used = byteLength(JSON.stringify(packed)) + markerBytes
  }

  let full = false
  let storageTruncated = false
  statements.forEach((s, i) => {
    const entry = packed[i]!
    for (const row of s.results) {
      if (full) break
      const cost = byteLength(JSON.stringify(row)) + 1 // + separating comma
      if (used + cost > budget) {
        full = true
        break
      }
      entry.results.push(row)
      used += cost
    }
    if (entry.results.length < s.results.length) {
      entry.stored_rows = entry.results.length
      storageTruncated = true
    }
  })

  const json = JSON.stringify(packed)
  return {
    json,
    bytes: byteLength(json),
    rowCount: statements.reduce((n, s) => n + s.results.length, 0),
    errorCount: statements.filter((s) => s.error !== undefined).length,
    storageTruncated,
  }
}

// ── Limits ────────────────────────────────────────────────────────────────────

// An integer in [min, max], or null for anything else (missing, malformed, out of range)
export function parseBoundedInt(value: unknown, min: number, max: number): number | null {
  const s = typeof value === 'number' ? String(value) : value
  if (typeof s !== 'string' || !/^\d+$/.test(s)) return null
  const n = Number(s)
  return n >= min && n <= max ? n : null
}

export interface RunPolicy {
  adminLimit: number
  userLimit: number | null
  effectiveLimit: number
  quotaBytes: number
}

export function runPolicy(adminLimitRaw: unknown, quotaMbRaw: unknown, userLimitRaw: unknown): RunPolicy {
  const adminLimit = parseBoundedInt(adminLimitRaw, 1, MAX_RUN_LIMIT) ?? DEFAULT_RUN_LIMIT
  const quotaMb = parseBoundedInt(quotaMbRaw, 1, MAX_RUN_QUOTA_MB) ?? DEFAULT_RUN_QUOTA_MB
  const userLimit = parseBoundedInt(userLimitRaw, 1, MAX_RUN_LIMIT)
  return {
    adminLimit,
    userLimit,
    effectiveLimit: Math.min(userLimit ?? adminLimit, adminLimit),
    quotaBytes: quotaMb * 1024 * 1024,
  }
}

export async function getRunPolicy(env: Env, userId: string): Promise<RunPolicy> {
  const T = tables(env)
  const row = await env.DB.prepare(
    `SELECT (SELECT value FROM ${T.settings} WHERE key = 'notebook_run_limit') AS admin_limit,
            (SELECT value FROM ${T.settings} WHERE key = 'run_storage_quota_mb') AS quota_mb,
            (SELECT notebook_run_limit FROM ${T.users} WHERE id = ?1) AS user_limit`
  )
    .bind(userId)
    .first<{ admin_limit: string | null; quota_mb: string | null; user_limit: number | null }>()
  return runPolicy(row?.admin_limit, row?.quota_mb, row?.user_limit)
}

// ── Saving and pruning ────────────────────────────────────────────────────────

export interface NewRun {
  id: string
  notebookId: string
  userId: string
  databaseId: string
  sql: string
  statements: RunStatement[]
  durationMs: number
  executedAt: number // milliseconds, so runs started within the same second keep their order
}

// Inserts the run and prunes, in one batch, the notebook down to its run limit and the user down
// to the storage quota. The new run is always kept: it is the newest, and a single run's results
// (at most MAX_STORED_RESULT_BYTES) are smaller than the smallest quota.
export async function saveRun(env: Env, run: NewRun): Promise<void> {
  const T = tables(env)
  const policy = await getRunPolicy(env, run.userId)
  const packed = packRunResults(run.statements)
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO ${T.notebook_runs} (id, notebook_id, user_id, database_id, sql, statement_count, row_count,
         error_count, duration_ms, storage_truncated, results_bytes, executed_at, results)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)`
    ).bind(
      run.id,
      run.notebookId,
      run.userId,
      run.databaseId,
      run.sql.slice(0, SUMMARY_SQL_LENGTH),
      run.statements.length,
      packed.rowCount,
      packed.errorCount,
      run.durationMs,
      packed.storageTruncated ? 1 : 0,
      packed.bytes,
      run.executedAt,
      packed.json
    ),
    env.DB.prepare(
      `DELETE FROM ${T.notebook_runs} WHERE notebook_id = ?1 AND id NOT IN (
         SELECT id FROM ${T.notebook_runs} WHERE notebook_id = ?1 ORDER BY executed_at DESC, id DESC LIMIT ?2)`
    ).bind(run.notebookId, policy.effectiveLimit),
    env.DB.prepare(quotaPruneSql(T, true)).bind(policy.quotaBytes, run.userId),
  ])
}

// Deletes, newest first, every run past the point where the user's running total of stored bytes
// exceeds the quota (?1). Reads only the (user_id, executed_at, id, results_bytes) index.
function quotaPruneSql(T: ReturnType<typeof tables>, oneUser: boolean): string {
  return `DELETE FROM ${T.notebook_runs} WHERE id IN (
    SELECT id FROM (
      SELECT id, SUM(results_bytes) OVER (
        PARTITION BY user_id ORDER BY executed_at DESC, id DESC ROWS UNBOUNDED PRECEDING
      ) AS total
      FROM ${T.notebook_runs}${oneUser ? ' WHERE user_id = ?2' : ''}
    ) WHERE total > ?1
  )`
}

// Applies the current limits to the stored runs at once (after the admin changes the limits or a
// user lowers their own), for one user or for everybody.
export async function pruneRuns(env: Env, opts: { userId?: string } = {}): Promise<void> {
  const T = tables(env)
  const row = await env.DB.prepare(
    `SELECT (SELECT value FROM ${T.settings} WHERE key = 'notebook_run_limit') AS admin_limit,
            (SELECT value FROM ${T.settings} WHERE key = 'run_storage_quota_mb') AS quota_mb`
  ).first<{ admin_limit: string | null; quota_mb: string | null }>()
  const { adminLimit, quotaBytes } = runPolicy(row?.admin_limit, row?.quota_mb, null)
  const userFilter = opts.userId ? ' WHERE r.user_id = ?2' : ''
  const countPrune = env.DB.prepare(
    `DELETE FROM ${T.notebook_runs} WHERE id IN (
      SELECT id FROM (
        SELECT r.id, ROW_NUMBER() OVER (PARTITION BY r.notebook_id ORDER BY r.executed_at DESC, r.id DESC) AS rn,
               MIN(COALESCE(u.notebook_run_limit, ?1), ?1) AS keep
        FROM ${T.notebook_runs} r LEFT JOIN ${T.users} u ON u.id = r.user_id${userFilter}
      ) WHERE rn > keep
    )`
  )
  const quotaPrune = env.DB.prepare(quotaPruneSql(T, Boolean(opts.userId)))
  await env.DB.batch(
    opts.userId
      ? [countPrune.bind(adminLimit, opts.userId), quotaPrune.bind(quotaBytes, opts.userId)]
      : [countPrune.bind(adminLimit), quotaPrune.bind(quotaBytes)]
  )
}
