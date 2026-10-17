import { useState, useEffect, useRef, useCallback } from 'react'
import { ApiError, notebooksApi } from '../lib/api'
import {
  RUN_PAGE_SIZE,
  addRun,
  cacheResults,
  clearRunsState,
  emptyRunsState,
  receivePage,
  removeRun,
  type NotebookRunsState,
} from '../lib/runs'
import type { NotebookRunSummary, StatementResult } from '../types'

// Results of one saved run: being fetched, ready, hidden (the user lost access to its database)
// or failed to load
export type RunResults =
  | { status: 'loading' }
  | { status: 'ready'; results: StatementResult[] }
  | { status: 'denied' }
  | { status: 'failed' }

// A run in progress, or the outcome of one that was not saved (failed request, rejected statement)
interface Pending {
  running: boolean
  error: string
  transient: StatementResult[] | null
}

const idle: Pending = { running: false, error: '', transient: null }

export type RunOutcome = { run: NotebookRunSummary | null; results: StatementResult[] } | { error: string }

// Saved runs of the user's notebooks, kept per notebook so results never leak into another tab:
// a run started in one notebook lands in that notebook even if the user switched away meanwhile.
export function useNotebookRuns(activeId: string | null) {
  const [byNotebook, setByNotebook] = useState<Record<string, NotebookRunsState>>({})
  const [results, setResults] = useState<Map<string, RunResults>>(() => new Map())
  const [pending, setPending] = useState<Record<string, Pending>>({})
  const byNotebookRef = useRef(byNotebook)
  const resultsRef = useRef(results)

  useEffect(() => {
    byNotebookRef.current = byNotebook
  }, [byNotebook])
  useEffect(() => {
    resultsRef.current = results
  }, [results])

  const patchNotebook = useCallback((nbId: string, fn: (s: NotebookRunsState) => NotebookRunsState) => {
    setByNotebook((prev) => ({ ...prev, [nbId]: fn(prev[nbId] ?? emptyRunsState) }))
  }, [])

  const loadPage = useCallback(
    async (nbId: string, append: boolean) => {
      const offset = append ? (byNotebookRef.current[nbId]?.list.length ?? 0) : 0
      patchNotebook(nbId, (s) => ({ ...s, loading: true, loadError: false }))
      try {
        const page = await notebooksApi.runs(nbId, { limit: RUN_PAGE_SIZE, offset })
        patchNotebook(nbId, (s) => receivePage(s, page.results, page.has_more, append))
      } catch {
        patchNotebook(nbId, (s) => ({ ...s, loading: false, loadError: true }))
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
      .then((run) => setResults((prev) => cacheResults(prev, selectedRunId, { status: 'ready', results: run.results })))
      .catch((err) =>
        setResults((prev) =>
          cacheResults(prev, selectedRunId, {
            status: err instanceof ApiError && err.status === 403 ? 'denied' : 'failed',
          })
        )
      )
  }, [activeId, selectedRunId, selectedAccessible])

  const clearPending = useCallback((nbId: string) => {
    setPending((prev) => (prev[nbId] && !prev[nbId].running ? { ...prev, [nbId]: idle } : prev))
  }, [])

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
    patchNotebook(nbId, clearRunsState)
    clearPending(nbId)
  }, [activeId, patchNotebook, clearPending])

  const startRun = useCallback((nbId: string) => {
    setPending((prev) => ({ ...prev, [nbId]: { running: true, error: '', transient: null } }))
  }, [])

  const finishRun = useCallback(
    (nbId: string, outcome: RunOutcome) => {
      if ('error' in outcome) {
        setPending((prev) => ({ ...prev, [nbId]: { ...idle, error: outcome.error } }))
        return
      }
      const { run } = outcome
      if (!run) {
        setPending((prev) => ({ ...prev, [nbId]: { ...idle, transient: outcome.results } }))
        return
      }
      setResults((prev) => cacheResults(prev, run.id, { status: 'ready', results: outcome.results }))
      patchNotebook(nbId, (s) => addRun(s, run))
      setPending((prev) => ({ ...prev, [nbId]: idle }))
    },
    [patchNotebook]
  )

  // Drops a deleted notebook's state (its runs are deleted with it on the server)
  const forgetNotebook = useCallback((nbId: string) => {
    setByNotebook(({ [nbId]: _gone, ...rest }) => rest)
    setPending(({ [nbId]: _gone, ...rest }) => rest)
  }, [])

  const activePending = (activeId && pending[activeId]) || idle
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
    runError: activePending.error,
    transient: activePending.transient,
    selectRun,
    loadMore,
    deleteRun,
    clearRuns,
    startRun,
    finishRun,
    forgetNotebook,
  }
}
