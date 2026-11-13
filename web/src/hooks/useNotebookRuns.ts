import { useState, useEffect, useRef, useCallback } from 'react'
import { ApiError, notebooksApi } from '../lib/api'
import {
  RUN_PAGE_SIZE,
  addRun,
  cacheResults,
  clearRunsState,
  emptyRunsState,
  idlePending,
  receivePage,
  removeRun,
  runCancelNotice,
  runHaltNotice,
  runningPending,
  settleRun,
  withCancelling,
  type CancelNotice,
  type HaltNotice,
  type NotebookRunsState,
  type PendingRun,
  type RunOutcome,
} from '../lib/runs'
import type { StatementResult } from '../types'

// Results of one saved run: being fetched, ready, hidden (the user lost access to its database)
// or failed to load. `halted` and `cancelled` are the notices the run's own record earns (they are
// stored with the run), so a run opened from history announces the same halt or cancellation as the
// response that created it.
export type RunResults =
  | { status: 'loading' }
  | { status: 'ready'; results: StatementResult[]; halted?: HaltNotice | null; cancelled?: CancelNotice | null }
  | { status: 'denied' }
  | { status: 'failed' }

// Saved runs of the user's notebooks, kept per notebook so results never leak into another tab:
// a run started in one notebook lands in that notebook even if the user switched away meanwhile.
export function useNotebookRuns(activeId: string | null) {
  const [byNotebook, setByNotebook] = useState<Record<string, NotebookRunsState>>({})
  const [results, setResults] = useState<Map<string, RunResults>>(() => new Map())
  const [pending, setPending] = useState<Record<string, PendingRun>>({})
  const byNotebookRef = useRef(byNotebook)
  const resultsRef = useRef(results)
  // The pending state as of the latest write, so a cancel is visible to the response that is
  // arriving right after it (state alone would trail a render behind)
  const pendingRef = useRef<Record<string, PendingRun>>({})
  // Notebooks with a page request in flight, so scroll events cannot ask for the same page twice
  const fetching = useRef(new Set<string>())
  // Bumped when a notebook's runs are cleared: a page requested before the clear must not
  // repopulate the list with records the clear just deleted
  const generations = useRef(new Map<string, number>())

  useEffect(() => {
    byNotebookRef.current = byNotebook
  }, [byNotebook])
  useEffect(() => {
    resultsRef.current = results
  }, [results])

  const patchNotebook = useCallback((nbId: string, fn: (s: NotebookRunsState) => NotebookRunsState) => {
    setByNotebook((prev) => ({ ...prev, [nbId]: fn(prev[nbId] ?? emptyRunsState) }))
  }, [])

  const commitPending = useCallback((nbId: string, value: PendingRun) => {
    pendingRef.current = { ...pendingRef.current, [nbId]: value }
    setPending(pendingRef.current)
  }, [])

  const loadPage = useCallback(
    async (nbId: string, append: boolean) => {
      if (fetching.current.has(nbId)) return
      fetching.current.add(nbId)
      // Older pages continue below the oldest run listed
      const before = append ? byNotebookRef.current[nbId]?.list.at(-1)?.seq : undefined
      const generation = generations.current.get(nbId) ?? 0
      patchNotebook(nbId, (s) => ({ ...s, loading: true, loadError: false }))
      try {
        const page = await notebooksApi.runs(nbId, { limit: RUN_PAGE_SIZE, before })
        // The notebook was cleared meanwhile: its runs are gone, so this page is stale
        if ((generations.current.get(nbId) ?? 0) !== generation) return
        patchNotebook(nbId, (s) => receivePage(s, page.results, page.has_more, append))
      } catch {
        if ((generations.current.get(nbId) ?? 0) !== generation) return
        patchNotebook(nbId, (s) => ({ ...s, loading: false, loadError: true }))
      } finally {
        fetching.current.delete(nbId)
      }
    },
    [patchNotebook]
  )

  // Load a notebook's runs the first time it is shown
  useEffect(() => {
    if (!activeId) return
    const s = byNotebookRef.current[activeId]
    if (s?.loaded || s?.loading) return
    loadPage(activeId, false)
  }, [activeId, loadPage])

  const active = (activeId && byNotebook[activeId]) || emptyRunsState
  const selectedRun = active.list.find((r) => r.id === active.selectedRunId) ?? null
  const selectedRunId = selectedRun?.id ?? null
  const selectedAccessible = selectedRun?.accessible ?? false

  // Fetch the selected run's results unless they are cached
  useEffect(() => {
    if (!activeId || !selectedRunId || !selectedAccessible) return
    const cached = resultsRef.current.get(selectedRunId)
    if (cached && cached.status !== 'failed') {
      setResults((prev) => cacheResults(prev, selectedRunId, cached)) // mark as recently used
      return
    }
    setResults((prev) => cacheResults(prev, selectedRunId, { status: 'loading' }))
    notebooksApi
      .run(activeId, selectedRunId)
      .then((run) =>
        setResults((prev) =>
          cacheResults(prev, selectedRunId, {
            status: 'ready',
            results: run.results,
            halted: runHaltNotice(run, run.results),
            cancelled: runCancelNotice(run),
          })
        )
      )
      .catch((err) =>
        setResults((prev) =>
          cacheResults(prev, selectedRunId, {
            status: err instanceof ApiError && err.status === 403 ? 'denied' : 'failed',
          })
        )
      )
  }, [activeId, selectedRunId, selectedAccessible])

  const clearPending = useCallback(
    (nbId: string) => {
      const current = pendingRef.current[nbId]
      if (current && !current.running) commitPending(nbId, idlePending)
    },
    [commitPending]
  )

  const selectRun = useCallback(
    (runId: string) => {
      if (!activeId) return
      patchNotebook(activeId, (s) => ({ ...s, selectedRunId: runId }))
      clearPending(activeId)
    },
    [activeId, patchNotebook, clearPending]
  )

  const loadMore = useCallback(() => {
    if (activeId) loadPage(activeId, true)
  }, [activeId, loadPage])

  const deleteRun = useCallback(
    async (runId: string) => {
      if (!activeId) return
      const nbId = activeId
      // A 404 means it is gone already (or was never stored): drop it all the same
      await notebooksApi.deleteRun(nbId, runId).catch((err) => {
        if (!(err instanceof ApiError && err.status === 404)) throw err
      })
      patchNotebook(nbId, (s) => removeRun(s, runId))
      setResults((prev) => {
        const next = new Map(prev)
        next.delete(runId)
        return next
      })
    },
    [activeId, patchNotebook]
  )

  const clearRuns = useCallback(async () => {
    if (!activeId) return
    const nbId = activeId
    await notebooksApi.clearRuns(nbId)
    generations.current.set(nbId, (generations.current.get(nbId) ?? 0) + 1)
    patchNotebook(nbId, clearRunsState)
    clearPending(nbId)
  }, [activeId, patchNotebook, clearPending])

  const startRun = useCallback(
    (nbId: string, databaseName: string, sql: string, statementCount: number) => {
      commitPending(nbId, runningPending(databaseName, sql, statementCount))
    },
    [commitPending]
  )

  const finishRun = useCallback(
    (nbId: string, outcome: RunOutcome) => {
      // A run that is no longer in flight (cancelled meanwhile) drops its late response
      const settled = settleRun(pendingRef.current[nbId] ?? idlePending, outcome)
      if (!settled.accepted) return
      const run = settled.run
      if (run) {
        // The notices ride with this run's results, so selecting it again shows them too
        const halted = 'error' in outcome ? null : (outcome.halted ?? null)
        const cancelled = 'error' in outcome ? null : (outcome.cancelled ?? null)
        setResults((prev) =>
          cacheResults(prev, run.id, { status: 'ready', results: settled.results, halted, cancelled })
        )
        patchNotebook(nbId, (s) => addRun(s, run))
      }
      commitPending(nbId, settled.pending)
    },
    [commitPending, patchNotebook]
  )

  // The cancel signal is on its way (see pages/Query.tsx): the run keeps running, the button says
  // 正在取消… until its response lands and finishRun clears the flag with the rest of the pending run
  const setCancelling = useCallback(
    (nbId: string, cancelling: boolean) => {
      const current = pendingRef.current[nbId] ?? idlePending
      const next = withCancelling(current, cancelling)
      if (next !== current) commitPending(nbId, next)
    },
    [commitPending]
  )

  // Drops a deleted notebook's state (its runs are deleted with it on the server)
  const forgetNotebook = useCallback((nbId: string) => {
    setByNotebook(({ [nbId]: _gone, ...rest }) => rest)
    const { [nbId]: _pending, ...restPending } = pendingRef.current
    pendingRef.current = restPending
    setPending(restPending)
  }, [])

  const activePending = (activeId && pending[activeId]) || idlePending
  let selectedResults: RunResults | null = null
  if (selectedRun) {
    selectedResults = selectedRun.accessible
      ? (results.get(selectedRun.id) ?? { status: 'loading' })
      : { status: 'denied' }
  }

  return {
    list: active.list,
    hasMore: active.hasMore,
    loading: active.loading,
    loaded: active.loaded,
    loadError: active.loadError,
    selectedRun,
    selectedResults,
    running: activePending.running,
    cancelling: activePending.cancelling,
    runningDatabaseName: activePending.databaseName,
    runningSql: activePending.sql,
    runningStatementCount: activePending.statementCount,
    runError: activePending.error,
    transient: activePending.transient,
    transientHalted: activePending.halted,
    transientCancelled: activePending.cancelled,
    selectRun,
    loadMore,
    deleteRun,
    clearRuns,
    startRun,
    finishRun,
    setCancelling,
    forgetNotebook,
  }
}
