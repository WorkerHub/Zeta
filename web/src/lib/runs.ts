import type { NotebookRunSummary } from '../types'

// ── Per-notebook state of the saved runs (see hooks/useNotebookRuns.ts) ──────

export const RUN_PAGE_SIZE = 50
// Run results kept in memory; older ones are fetched again when selected
export const RESULT_CACHE_SIZE = 20

export interface NotebookRunsState {
  list: NotebookRunSummary[] // newest first
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
    const newest = page[0]?.executed_at ?? 0
    list = [...s.list.filter((r) => !known.has(r.id) && r.executed_at >= newest), ...page]
  }
  return withSelection({ ...s, list, hasMore, loaded: true, loading: false, loadError: false })
}

// A run just made in this tab goes first and becomes the selected one
export function addRun(s: NotebookRunsState, run: NotebookRunSummary): NotebookRunsState {
  return { ...s, list: [run, ...s.list.filter((r) => r.id !== run.id)], selectedRunId: run.id }
}

// Removing the selected run selects the one that took its place (the next older, else the newest)
export function removeRun(s: NotebookRunsState, runId: string): NotebookRunsState {
  const idx = s.list.findIndex((r) => r.id === runId)
  if (idx === -1) return s
  const list = s.list.filter((r) => r.id !== runId)
  if (s.selectedRunId !== runId) return { ...s, list }
  return { ...s, list, selectedRunId: (list[idx] ?? list[idx - 1])?.id ?? null }
}

export function clearRunsState(s: NotebookRunsState): NotebookRunsState {
  return { ...s, list: [], hasMore: false, loaded: true, selectedRunId: null }
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
