import type { DbKind, NotebookRunSummary, StatementResult } from '../types'

// ── Per-notebook state of the saved runs and of the run in flight ────────────
// (see hooks/useNotebookRuns.ts)

export const RUN_PAGE_SIZE = 50
// Run results kept in memory; older ones are fetched again when selected
export const RESULT_CACHE_SIZE = 20

export interface NotebookRunsState {
  list: NotebookRunSummary[] // newest (highest number) first
  hasMore: boolean
  loaded: boolean
  loading: boolean
  loadError: boolean
  selectedRunId: string | null
}

export const emptyRunsState: NotebookRunsState = {
  list: [],
  hasMore: false,
  loaded: false,
  loading: false,
  loadError: false,
  selectedRunId: null,
}

const withSelection = (s: NotebookRunsState): NotebookRunsState =>
  s.selectedRunId && s.list.some((r) => r.id === s.selectedRunId) ? s : { ...s, selectedRunId: s.list[0]?.id ?? null }

// A page from the server. The first page replaces the list but keeps runs made here that the
// server has not stored yet (they are saved in the background); later pages are appended. Selects
// the newest run when none is selected.
export function receivePage(
  s: NotebookRunsState,
  page: NotebookRunSummary[],
  hasMore: boolean,
  append: boolean
): NotebookRunsState {
  const known = new Set(page.map((r) => r.id))
  let list: NotebookRunSummary[]
  if (append) {
    list = [...s.list, ...page.filter((r) => !s.list.some((x) => x.id === r.id))]
  } else {
    const newest = page[0]?.seq ?? 0
    list = [...s.list.filter((r) => !known.has(r.id) && r.seq > newest), ...page]
  }
  return withSelection({ ...s, list, hasMore, loaded: true, loading: false, loadError: false })
}

// A run just made in this tab joins the list by its number (normally first) and becomes the
// selected one
export function addRun(s: NotebookRunsState, run: NotebookRunSummary): NotebookRunsState {
  const list = [run, ...s.list.filter((r) => r.id !== run.id)].sort((a, b) => b.seq - a.seq)
  return { ...s, list, selectedRunId: run.id }
}

// Removing the selected run selects the one that took its place (the next older, else the newest)
export function removeRun(s: NotebookRunsState, runId: string): NotebookRunsState {
  const idx = s.list.findIndex((r) => r.id === runId)
  if (idx === -1) return s
  const list = s.list.filter((r) => r.id !== runId)
  if (s.selectedRunId !== runId) return { ...s, list }
  return { ...s, list, selectedRunId: (list[idx] ?? list[idx - 1])?.id ?? null }
}

// ── The run in flight ────────────────────────────────────────────────────────

// A run the user cancelled, as the results area announces it. `caveat` is the one thing the
// cancellation of a flag-only engine owes the reader: D1 and TiDB have no way to kill a statement,
// so the one in flight still finishes on the server while the statements after it never run.
// PostgreSQL and Spark really kill it, so they carry no caveat.
export interface CancelNotice {
  caveat: boolean
}

// The notice a cancelled execution earns, by the engine it targeted. Every engine announces the
// cancellation; only the flag-only engines add the caveat — D1 and TiDB cannot kill the statement
// in flight, PostgreSQL and Spark do.
export function cancelNotice(kind: DbKind): CancelNotice {
  return { caveat: kind === 'sqlite' || kind === 'mysql' }
}

// The notice a run opened from history earns. Its record keeps the `cancelled` flag but not the
// engine that ran it, so it announces the cancellation without claiming a caveat.
export function runCancelNotice(run: { cancelled?: boolean }): CancelNotice | null {
  return run.cancelled ? { caveat: false } : null
}

// A batch that stopped at its first failing statement (the worker's `halted`): the failing
// statement's position (from 1) and how many submitted statements never ran.
export interface HaltNotice {
  failedAt: number
  remaining: number
}

// The notice a batch response earns. A run that completed is not halted (the worker leaves
// `halted` out or sends false), and a halt that left nothing unrun has nothing to announce, so
// both give null. The failing statement is the last entry carrying an error; the position falls
// back to the returned count when the worker sent no error entry.
export function haltNotice(
  halted: boolean | undefined,
  results: StatementResult[],
  submitted: number
): HaltNotice | null {
  const remaining = submitted - results.length
  if (!halted || results.length === 0 || remaining <= 0) return null
  let failedAt = results.length
  for (let i = results.length - 1; i >= 0; i--) {
    if (results[i]!.error) {
      failedAt = i + 1
      break
    }
  }
  return { failedAt, remaining }
}

// The notice a run saved by the worker carries: its record keeps `halted` and how many statements
// the run submitted (`statement_count`), so a run opened from history — after a reload or on
// another device — announces the same halt as the response that created it. A record from before
// the halt column existed has no `halted`, and one whose counts do not leave anything unrun gives
// null, so nothing is ever announced from guesswork.
export function runHaltNotice(
  run: { halted?: boolean; statement_count: number },
  results: StatementResult[]
): HaltNotice | null {
  return haltNotice(run.halted, results, run.statement_count)
}

// A run in progress, or what one left behind when the server did not name it: an error message,
// or results that were not stored as a run (transient). `databaseName` is the database the run
// was started on, shown in the history strip while it runs. `sql` is the statement the run is
// executing (the first one when several were submitted) and `statementCount` how many there are,
// which the results panel names while it runs. `halted` and `cancelled` ride with the transient
// results (a saved run carries its own notices with its cached results). `cancelling` is set while
// the cancel signal is on its way — the run itself is still in flight until its response lands.
export interface PendingRun {
  running: boolean
  cancelling: boolean
  error: string
  transient: StatementResult[] | null
  halted: HaltNotice | null
  cancelled: CancelNotice | null
  databaseName: string
  sql: string
  statementCount: number
}

export const idlePending: PendingRun = {
  running: false,
  cancelling: false,
  error: '',
  transient: null,
  halted: null,
  cancelled: null,
  databaseName: '',
  sql: '',
  statementCount: 0,
}

export const runningPending = (databaseName: string, sql: string, statementCount: number): PendingRun => ({
  running: true,
  cancelling: false,
  error: '',
  transient: null,
  halted: null,
  cancelled: null,
  databaseName,
  sql,
  statementCount,
})

// The cancel signal is in flight: the button says so, the run keeps running. A run that is not in
// flight is returned untouched, so a late write cannot make an idle notebook look like it is
// cancelling something.
export function withCancelling(pending: PendingRun, cancelling: boolean): PendingRun {
  return pending.running && pending.cancelling !== cancelling ? { ...pending, cancelling } : pending
}

export type RunOutcome =
  | {
      run: NotebookRunSummary | null
      results: StatementResult[]
      halted?: HaltNotice | null
      cancelled?: CancelNotice | null
    }
  | { error: string }

// Applies a run's outcome only while that notebook's run is still in flight: a response arriving
// after the page dropped the request (a notebook deleted, the page left) is rejected. A cancelled
// execution is an outcome like any other — its `cancelled: true` response is expected and lands.
export type SettledRun =
  | { accepted: false; pending: PendingRun }
  | { accepted: true; pending: PendingRun; run: NotebookRunSummary | null; results: StatementResult[] }

export function settleRun(pending: PendingRun, outcome: RunOutcome): SettledRun {
  if (!pending.running) return { accepted: false, pending }
  if ('error' in outcome)
    return { accepted: true, pending: { ...idlePending, error: outcome.error }, run: null, results: [] }
  if (!outcome.run)
    return {
      accepted: true,
      pending: {
        ...idlePending,
        transient: outcome.results,
        halted: outcome.halted ?? null,
        cancelled: outcome.cancelled ?? null,
      },
      run: null,
      results: outcome.results,
    }
  return { accepted: true, pending: idlePending, run: outcome.run, results: outcome.results }
}

export function clearRunsState(s: NotebookRunsState): NotebookRunsState {
  // Also settles a page that was in flight when the clear happened (its response is dropped)
  return { ...s, list: [], hasMore: false, loaded: true, loading: false, loadError: false, selectedRunId: null }
}

// Stores `value` as the most recently used entry, evicting the least recently used beyond `max`
export function cacheResults<V>(cache: Map<string, V>, key: string, value: V, max = RESULT_CACHE_SIZE): Map<string, V> {
  const next = new Map(cache)
  next.delete(key)
  next.set(key, value)
  for (const oldest of next.keys()) {
    if (next.size <= max) break
    next.delete(oldest)
  }
  return next
}
