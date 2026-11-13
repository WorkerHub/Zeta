import type { Env } from '../types'
import { now, tables } from './db'

// ── Execution registry and cancellation ───────────────────────────────────────
// Every query request that carries an `executionId` registers here before its first statement runs,
// and `POST /api/query/cancel` addresses that row to stop it (see routes/query.ts). The row is the
// single source of truth for "a cancellation was asked for": the running request reads
// `cancel_requested_at` at every statement boundary, and engines whose kill channel cannot be
// trusted (or exists at all) still honour it there.
//
// The registry lives in the application D1 database, not in a Durable Object or KV: the request
// that runs and the request that cancels are different isolates, D1 is already the one state every
// request shares (auth, permissions and history all read it), and its conditional UPDATE is atomic,
// which is what makes a cancel idempotent and a late cancel harmless (see below).
//
// Rules this module encodes — never work around them at a call site:
//   * registration happens before anything runs, so an early cancel is never lost;
//   * the cancel request performs one conditional UPDATE (`finished_at IS NULL AND
//     cancel_requested_at IS NULL`) and only a caller that won it may send an engine-side kill, so a
//     kill can never land on a later execution of the same session;
//   * only the initiator may cancel: `user_id` is part of every WHERE clause, admins included;
//   * `handle` (an engine-side address such as the PostgreSQL application_name marker) is never
//     returned to a client and never logged;
//   * rows are pruned by age, so an execution whose request died without finishing cannot pile up.

// How long an execution row is kept after it started. Comfortably longer than any request (the
// Spark statement timeout is 300 s), and short enough that the table stays tiny.
const RETENTION_SECONDS = 24 * 60 * 60

export type ExecutionOutcome = 'ok' | 'error' | 'cancelled'

export interface NewExecution {
  id: string
  userId: string
  databaseId: string
  kind: string
  // The engine-side address a kill needs; null for engines that only stop between statements.
  handle: string | null
}

interface ExecutionRow {
  user_id: string | null
  kind: string
  database_id: string | null
  handle: string | null
  finished_at: number | null
}

// Writes the registry row for a request that is about to run. `created: false` means the id is in
// use by another execution that has not finished yet — the caller answers 409 rather than running
// two executions under one id (their ids also address the engine-side kill, so a duplicate would
// make one cancel hit both). A finished row of the same user is taken over: a client that retries
// after a network error may legitimately reuse its id.
export async function beginExecution(env: Env, exec: NewExecution): Promise<{ created: boolean }> {
  const T = tables(env)
  const startedAt = now()
  const inserted = await env.DB.prepare(
    `INSERT INTO ${T.executions} (id, user_id, database_id, kind, handle, started_at, cancel_requested_at, finished_at, outcome)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, NULL, NULL)
     ON CONFLICT(id) DO NOTHING
     RETURNING id`
  )
    .bind(exec.id, exec.userId, exec.databaseId, exec.kind, exec.handle, startedAt)
    .first<{ id: string }>()
  if (inserted) return { created: true }

  const taken = await env.DB.prepare(
    `UPDATE ${T.executions}
     SET user_id = ?2, database_id = ?3, kind = ?4, handle = ?5, started_at = ?6,
         cancel_requested_at = NULL, finished_at = NULL, outcome = NULL
     WHERE id = ?1 AND user_id = ?2 AND finished_at IS NOT NULL
     RETURNING id`
  )
    .bind(exec.id, exec.userId, exec.databaseId, exec.kind, exec.handle, startedAt)
    .first<{ id: string }>()
  return { created: taken !== null }
}

// Whether a cancellation has been asked for. One cheap read per statement boundary is the whole
// "stop between statements" mechanism for D1 and TiDB, and the classifier for Spark's and
// PostgreSQL's interrupted statements (their failure text is not trustworthy evidence).
export async function cancelRequested(env: Env, id: string): Promise<boolean> {
  const T = tables(env)
  const row = await env.DB.prepare(`SELECT cancel_requested_at FROM ${T.executions} WHERE id = ?1`)
    .bind(id)
    .first<{ cancel_requested_at: number | null }>()
  return row?.cancel_requested_at != null
}

// Closes a registration. Only the first call wins: a request that was already finished (or pruned)
// stays as it was.
export async function finishExecution(env: Env, id: string, outcome: ExecutionOutcome): Promise<void> {
  const T = tables(env)
  await env.DB.prepare(
    `UPDATE ${T.executions} SET finished_at = ?2, outcome = ?3 WHERE id = ?1 AND finished_at IS NULL`
  )
    .bind(id, now(), outcome)
    .run()
}

// Drops rows older than the retention window. Best effort and off the request's critical path (see
// the call sites): a failed cleanup must never fail a query.
export async function pruneExecutions(env: Env): Promise<void> {
  const T = tables(env)
  await env.DB.prepare(`DELETE FROM ${T.executions} WHERE started_at < ?1`)
    .bind(now() - RETENTION_SECONDS)
    .run()
}

export type CancelRequest =
  // No such execution, or not this caller's: the two are indistinguishable by design.
  | { found: false }
  // The execution had already finished: there is nothing to stop and no kill is sent.
  | { found: true; state: 'finished' }
  // A cancellation is in effect. `dispatched` is true only for the caller that actually flipped the
  // flag — a repeat cancel answers the same way but must not send a second kill.
  | {
      found: true
      state: 'cancelled'
      dispatched: boolean
      userId: string
      databaseId: string
      kind: string
      handle: string | null
    }

// Records a cancellation request. The conditional UPDATE is the whole permission model and the whole
// late-cancel guard: it only matches a row of this caller that is still running and not yet
// cancelled. `RETURNING` gives the kill the row it needs without a second round trip.
export async function requestExecutionCancel(env: Env, id: string, userId: string): Promise<CancelRequest> {
  const T = tables(env)
  const dispatched = await env.DB.prepare(
    `UPDATE ${T.executions} SET cancel_requested_at = ?2
     WHERE id = ?1 AND user_id = ?3 AND cancel_requested_at IS NULL AND finished_at IS NULL
     RETURNING user_id, kind, database_id, handle`
  )
    .bind(id, now(), userId)
    .first<ExecutionRow>()

  if (dispatched) {
    return {
      found: true,
      state: 'cancelled',
      dispatched: true,
      userId,
      databaseId: dispatched.database_id ?? '',
      kind: dispatched.kind,
      handle: dispatched.handle,
    }
  }

  const row = await env.DB.prepare(
    `SELECT user_id, kind, database_id, handle, finished_at FROM ${T.executions} WHERE id = ?1`
  )
    .bind(id)
    .first<ExecutionRow>()
  if (!row || row.user_id !== userId) return { found: false }
  if (row.finished_at !== null) return { found: true, state: 'finished' }
  return {
    found: true,
    state: 'cancelled',
    dispatched: false,
    userId,
    databaseId: row.database_id ?? '',
    kind: row.kind,
    handle: row.handle,
  }
}
