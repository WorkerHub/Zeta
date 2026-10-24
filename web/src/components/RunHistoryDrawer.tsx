import { useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties, KeyboardEvent, PointerEvent } from 'react'
import { AlertCircle, CheckCircle2, History, Loader2, Trash2, X } from 'lucide-react'
import { useLocale } from '../hooks/useLocale'
import {
  HISTORY_DRAWER_KEY_STEP,
  clampHistoryDrawerWidth,
  defaultHistoryDrawerWidth,
  historyDrawerBounds,
} from '../lib/drawerWidth'
import { timeAgo } from '../lib/time'
import type { RunResults } from '../hooks/useNotebookRuns'
import type { NotebookRunSummary } from '../types'
import ResultsPanel from './ResultsPanel'
import ConfirmDialog from './ConfirmDialog'

interface Props {
  runs: NotebookRunSummary[] // newest (highest number) first
  selectedRun: NotebookRunSummary | null
  selectedResults: RunResults | null
  hasMore: boolean
  loading: boolean
  loadError: boolean
  onSelect: (runId: string) => void
  onLoadMore: () => void
  onDelete: (runId: string) => Promise<void>
  onClear: () => Promise<void>
  onClose: () => void
}

// How close (px) to the end of the list the next page of older runs is loaded
const LOAD_MORE_MARGIN = 96

// A side drawer listing every saved run of the current notebook: the list on the left (top on
// phones), the SQL and results of the selected run on the right. It shares its state with the
// tab strip, so deleting or clearing here updates the tabs and selecting there updates the
// detail — and the other way round.
export default function RunHistoryDrawer({
  runs,
  selectedRun,
  selectedResults,
  hasMore,
  loading,
  loadError,
  onSelect,
  onLoadMore,
  onDelete,
  onClear,
  onClose,
}: Props) {
  const { t, locale } = useLocale()
  const panelRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const itemRefs = useRef(new Map<string, HTMLButtonElement>())
  // A run being deleted, or 'all' while the notebook is cleared
  const [busy, setBusy] = useState<string | null>(null)
  const [actionError, setActionError] = useState('')
  // 'Clear all' asks via the design-system ConfirmDialog (§3.1: no window.confirm)
  const [confirmClear, setConfirmClear] = useState(false)
  const [resultIdx, setResultIdx] = useState(0)
  const selectedRunId = selectedRun?.id ?? null
  // The drawer opens at half the window; dragging its inner edge (or the arrow keys) resizes it
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth)
  const [width, setWidth] = useState(() => defaultHistoryDrawerWidth(window.innerWidth))
  const [resizing, setResizing] = useState(false)
  const dragging = useRef(false)
  const dragStart = useRef({ x: 0, width: 0 })
  const bounds = historyDrawerBounds(viewportWidth)

  // Focus moves into the drawer while it is open, and back to whatever opened it on close; the
  // History button is gone once the list is empty, so fall back to the notebook's active tab
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    closeRef.current?.focus()
    return () => {
      const target = previous?.isConnected
        ? previous
        : document.querySelector<HTMLElement>('#notebook-tabs [role="tab"][aria-selected="true"]')
      target?.focus()
    }
  }, [])

  // Esc closes the drawer from anywhere inside it
  useEffect(() => {
    const onKeyDown = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  // Tab stays inside the dialog while it is open
  const trapFocus = useCallback((e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Tab') return
    const panel = panelRef.current
    if (!panel) return
    const focusable = [
      ...panel.querySelectorAll<HTMLElement>(
        'button:not([disabled]), a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
      ),
    ]
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    if (!first || !last) return
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault()
      first.focus()
    }
  }, [])

  // A window resize keeps the current width inside the allowed range for the new viewport
  useEffect(() => {
    const onResize = () => {
      setViewportWidth(window.innerWidth)
      setWidth((w) => clampHistoryDrawerWidth(w, window.innerWidth))
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  // While dragging, keep the resize cursor and stop text selection outside the handle
  useEffect(() => {
    if (!resizing) return
    const { body } = document
    const userSelect = body.style.userSelect
    const cursor = body.style.cursor
    body.style.userSelect = 'none'
    body.style.cursor = 'col-resize'
    return () => {
      body.style.userSelect = userSelect
      body.style.cursor = cursor
    }
  }, [resizing])

  // The drawer sits on the right, so a leftward pointer move makes it wider
  function startResize(e: PointerEvent<HTMLDivElement>) {
    if (e.button !== 0) return
    e.preventDefault()
    dragging.current = true
    dragStart.current = { x: e.clientX, width }
    setResizing(true)
    e.currentTarget.setPointerCapture(e.pointerId)
  }

  function resizeTo(e: PointerEvent<HTMLDivElement>) {
    if (!dragging.current) return
    setWidth(clampHistoryDrawerWidth(dragStart.current.width + dragStart.current.x - e.clientX, viewportWidth))
  }

  function stopResize(e: PointerEvent<HTMLDivElement>) {
    if (!dragging.current) return
    dragging.current = false
    setResizing(false)
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
  }

  // Arrow keys move the edge by a step (four with Shift); Home and End jump to the limits
  function resizeByKey(e: KeyboardEvent<HTMLDivElement>) {
    const step = e.shiftKey ? HISTORY_DRAWER_KEY_STEP * 4 : HISTORY_DRAWER_KEY_STEP
    let next: number
    if (e.key === 'ArrowLeft') next = width + step
    else if (e.key === 'ArrowRight') next = width - step
    else if (e.key === 'Home') next = bounds.min
    else if (e.key === 'End') next = bounds.max
    else return
    e.preventDefault()
    setWidth(clampHistoryDrawerWidth(next, viewportWidth))
  }

  // The detail starts at the first statement of whichever run is opened
  // biome-ignore lint/correctness/useExhaustiveDependencies: the selected run is the trigger, not an input of the effect
  useEffect(() => {
    setResultIdx(0)
  }, [selectedRunId])

  const ago = (run: NotebookRunSummary) => timeAgo(Math.floor(run.executed_at / 1000), locale)
  const outcome = (run: NotebookRunSummary) =>
    run.error_count > 0
      ? t('runs.errors', { n: run.error_count })
      : t(run.row_count === 1 ? 'results.row' : 'results.rows', { n: run.row_count })

  // Older runs load on reaching the end of the list; the button below is the keyboard fallback
  const loadMoreAtEnd = () => {
    const el = listRef.current
    if (!el || !hasMore || loading) return
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - LOAD_MORE_MARGIN) onLoadMore()
  }

  async function remove(runId: string) {
    setActionError('')
    setBusy(runId)
    // The hook selects the next older run (else the one above) when the selected one is deleted
    const index = runs.findIndex((r) => r.id === runId)
    const next = runs[index + 1] ?? runs[index - 1]
    const target = selectedRunId === runId ? next : runs.find((r) => r.id === selectedRunId)
    try {
      await onDelete(runId)
      // The row that held focus is gone: keep focus inside the drawer
      ;(target ? itemRefs.current.get(target.id) : closeRef.current)?.focus()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : t('errors.runs_failed'))
    } finally {
      setBusy(null)
    }
  }

  async function clearAll() {
    setConfirmClear(false)
    setActionError('')
    setBusy('all')
    try {
      await onClear()
      closeRef.current?.focus()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : t('errors.runs_failed'))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="fixed inset-0 z-(--z-drawer) flex justify-end">
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: backdrop is a pointer-only dismiss target; Esc and the close button close the drawer */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: pointer-only backdrop; the drawer has its own close button */}
      <div className="absolute inset-0 bg-black/40 animate-overlay-enter" onClick={onClose} />
      <div
        ref={panelRef}
        id="run-history-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="run-history-title"
        tabIndex={-1}
        onKeyDown={trapFocus}
        style={{ '--history-drawer-width': `${width}px` } as CSSProperties}
        className="relative flex h-full w-full flex-col border-l border-ink-200 bg-ink-0 shadow-lg outline-none @container animate-drawer-enter sm:w-[var(--history-drawer-width)]"
      >
        {/* Resize handle on the drawer's inner edge; phones keep the full-width stacked layout */}
        {/* biome-ignore lint/a11y/useSemanticElements: a draggable splitter must be focusable and expose aria-value* attributes; <hr> cannot */}
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label={t('runs.resize_width')}
          aria-controls="run-history-panel"
          aria-valuenow={width}
          aria-valuemin={bounds.min}
          aria-valuemax={bounds.max}
          aria-valuetext={`${width} px`}
          tabIndex={0}
          title={t('runs.resize_width')}
          onPointerDown={startResize}
          onPointerMove={resizeTo}
          onPointerUp={stopResize}
          onPointerCancel={stopResize}
          onLostPointerCapture={stopResize}
          onKeyDown={resizeByKey}
          className="group absolute inset-y-0 -left-2 z-10 hidden w-2 cursor-col-resize touch-none outline-none sm:block"
        >
          <div className="mx-auto h-full w-px bg-transparent transition-[width,background-color] duration-(--duration-base) ease-(--ease-standard) group-hover:w-0.5 group-hover:bg-brand-600 group-focus-visible:w-0.5 group-focus-visible:bg-brand-600 group-active:w-0.5 group-active:bg-brand-600 dark:group-hover:bg-brand-400 dark:group-focus-visible:bg-brand-400 dark:group-active:bg-brand-400" />
        </div>

        <div className="flex shrink-0 items-center gap-2 border-b border-ink-200 px-4 py-3">
          <History size={16} className="shrink-0 text-ink-400" aria-hidden="true" />
          <h2 id="run-history-title" className="text-heading text-ink-950">
            {t('runs.history_title')}
          </h2>
          <span className="text-caption tnum text-ink-500">
            {t('runs.history_count', { n: hasMore ? `${runs.length}+` : runs.length })}
          </span>
          <div className="flex-1" />
          <button
            type="button"
            onClick={() => setConfirmClear(true)}
            disabled={runs.length === 0 || busy !== null}
            className="flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-caption text-danger-600 transition-colors duration-(--duration-fast) hover:bg-danger-50 disabled:cursor-not-allowed disabled:opacity-40"
            title={t('runs.clear')}
            aria-label={t('runs.clear')}
          >
            {busy === 'all' ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
            {t('runs.clear_all')}
          </button>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            className="btn-ghost p-1.5"
            title={t('runs.close')}
            aria-label={t('runs.close')}
          >
            <X size={16} />
          </button>
        </div>

        {actionError && (
          <div className="flex shrink-0 items-start gap-2 border-b border-danger-200 bg-danger-50 px-4 py-2">
            <AlertCircle size={14} className="mt-0.5 shrink-0 text-danger-600" aria-hidden="true" />
            <p className="flex-1 text-caption text-danger-600">{actionError}</p>
            <button
              type="button"
              onClick={() => setActionError('')}
              className="rounded p-0.5 text-danger-600 hover:bg-danger-100"
              title={t('common.dismiss')}
              aria-label={t('common.dismiss')}
            >
              <X size={12} />
            </button>
          </div>
        )}

        {runs.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center text-body text-ink-400">
            <p className="flex items-center gap-2">
              {loading && <Loader2 size={14} className="animate-spin" />}
              {loading
                ? t('common.loading')
                : loadError
                  ? t('runs.list_failed')
                  : hasMore
                    ? t('runs.history_more_available')
                    : t('runs.history_empty')}
            </p>
            {/* Older records survive deleting every loaded one, so pagination stays reachable */}
            {hasMore && !loading && (
              <button
                type="button"
                onClick={onLoadMore}
                className="rounded-md px-3 py-1.5 text-caption text-brand-600 dark:text-brand-400 hover:bg-ink-100"
              >
                {loadError ? `${t('runs.list_failed')} · ${t('runs.load_more')}` : t('runs.load_more')}
              </button>
            )}
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col @min-[600px]:flex-row">
            {/* Run list */}
            <div className="flex max-h-[40%] min-h-0 shrink-0 flex-col border-b border-ink-200 @min-[600px]:max-h-none @min-[600px]:w-72 @min-[600px]:border-r @min-[600px]:border-b-0">
              <div ref={listRef} onScroll={loadMoreAtEnd} className="min-h-0 flex-1 overflow-y-auto">
                <ul>
                  {runs.map((run) => {
                    const active = run.id === selectedRunId
                    const failed = run.error_count > 0
                    return (
                      <li key={run.id}>
                        <div
                          className={`flex items-stretch pr-1.5 ${
                            active ? 'bg-brand-50' : 'hover:bg-ink-50'
                          }`}
                        >
                          <button
                            type="button"
                            ref={(el) => {
                              if (el) itemRefs.current.set(run.id, el)
                              else itemRefs.current.delete(run.id)
                            }}
                            onClick={() => onSelect(run.id)}
                            aria-current={active ? 'true' : undefined}
                            title={t('runs.view_run', { n: run.seq })}
                            className={`min-w-0 flex-1 border-l-2 px-3 py-2 text-left focus-visible:outline-2 focus-visible:outline-brand-600 dark:focus-visible:outline-brand-400 ${
                              active ? 'border-l-brand-600' : 'border-l-transparent'
                            }`}
                          >
                            <span className="flex items-center gap-1.5">
                              {failed ? (
                                <AlertCircle size={11} className="shrink-0 text-danger-600" aria-hidden="true" />
                              ) : (
                                <CheckCircle2 size={11} className="shrink-0 text-success-600" aria-hidden="true" />
                              )}
                              <span className="font-mono text-caption tnum text-ink-700">
                                #{run.seq}
                              </span>
                              <span className="truncate text-micro text-ink-500">{ago(run)}</span>
                              <span className="sr-only">{t(failed ? 'runs.failed' : 'runs.succeeded')}</span>
                            </span>
                            <span className="mt-0.5 block truncate text-micro text-ink-500">
                              {outcome(run)} · {run.duration_ms}ms
                            </span>
                            <span className="mt-0.5 block truncate font-mono text-micro text-ink-400">
                              {run.sql}
                            </span>
                          </button>
                          <button
                            type="button"
                            onClick={() => remove(run.id)}
                            disabled={busy !== null}
                            className="my-1 shrink-0 self-start rounded p-1 text-ink-400 transition-colors duration-(--duration-fast) hover:bg-ink-200/70 hover:text-danger-600 disabled:opacity-40"
                            title={t('runs.delete_run', { n: run.seq })}
                            aria-label={t('runs.delete_run', { n: run.seq })}
                          >
                            {busy === run.id ? <Loader2 size={11} className="animate-spin" /> : <Trash2 size={11} />}
                          </button>
                        </div>
                      </li>
                    )
                  })}
                </ul>
                {hasMore && (
                  <div className="p-2">
                    {loading ? (
                      <div className="flex items-center justify-center gap-2 py-2 text-caption text-ink-400">
                        <Loader2 size={12} className="animate-spin" />
                        {t('common.loading')}
                      </div>
                    ) : loadError ? (
                      <button
                        type="button"
                        onClick={onLoadMore}
                        className="w-full rounded-md py-1.5 text-caption text-danger-600 hover:bg-ink-100"
                      >
                        {t('runs.list_failed')} · {t('runs.load_more')}
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={onLoadMore}
                        className="w-full rounded-md py-1.5 text-caption text-brand-600 dark:text-brand-400 hover:bg-ink-100"
                      >
                        {t('runs.load_more')}
                      </button>
                    )}
                  </div>
                )}
              </div>
            </div>

            {/* Selected run: SQL and results */}
            <div className="flex min-h-0 flex-1 flex-col">
              {selectedRun ? (
                <>
                  <div className="shrink-0 border-b border-ink-200 px-4 py-2.5">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-caption">
                      {selectedRun.error_count > 0 ? (
                        <AlertCircle size={12} className="shrink-0 text-danger-600" aria-hidden="true" />
                      ) : (
                        <CheckCircle2 size={12} className="shrink-0 text-success-600" aria-hidden="true" />
                      )}
                      <span className="font-mono tnum text-ink-700">
                        #{selectedRun.seq}
                      </span>
                      <span className="text-ink-500">{new Date(selectedRun.executed_at).toLocaleString()}</span>
                      <span className="text-ink-300">·</span>
                      <span className="text-ink-500">{outcome(selectedRun)}</span>
                      <span className="text-ink-300">·</span>
                      <span className="text-ink-500">{selectedRun.duration_ms}ms</span>
                      {selectedRun.database_name && (
                        <>
                          <span className="text-ink-300">·</span>
                          <span className="truncate text-ink-500">{selectedRun.database_name}</span>
                        </>
                      )}
                    </div>
                    {selectedRun.storage_truncated > 0 && (
                      <p className="mt-1 text-caption text-warning-600">{t('runs.storage_truncated')}</p>
                    )}
                  </div>

                  <div className="shrink-0 border-b border-ink-200 px-4 py-2">
                    <p className="mb-1 text-micro uppercase text-ink-400">
                      {t('runs.sql')}
                    </p>
                    <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-ink-50 p-2 font-mono text-caption text-ink-700">
                      {selectedRun.sql}
                    </pre>
                  </div>

                  <div className="flex min-h-0 flex-1 flex-col">
                    {selectedResults?.status === 'ready' ? (
                      <div className="min-h-0 flex-1 overflow-hidden">
                        <ResultsPanel
                          results={selectedResults.results}
                          activeIndex={resultIdx}
                          onSelectIndex={setResultIdx}
                        />
                      </div>
                    ) : (
                      <div className="flex flex-1 items-center justify-center gap-2 px-4 text-center text-body text-ink-400">
                        {(!selectedResults || selectedResults.status === 'loading') && (
                          <Loader2 size={16} className="animate-spin" />
                        )}
                        {!selectedResults || selectedResults.status === 'loading'
                          ? t('runs.loading')
                          : selectedResults.status === 'denied'
                            ? t('runs.access_denied')
                            : t('runs.load_failed')}
                      </div>
                    )}
                  </div>
                </>
              ) : (
                <div className="flex flex-1 items-center justify-center px-6 text-center text-body text-ink-400">
                  {t('runs.history_hint')}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Clear-all confirmation (design-system dialog; exact count only once every page is loaded) */}
        {confirmClear && (
          <ConfirmDialog
            title={t('runs.clear')}
            description={
              hasMore ? t('runs.clear_confirm_more') : t('runs.clear_confirm', { n: runs.length })
            }
            busy={busy === 'all'}
            onCancel={() => setConfirmClear(false)}
            onConfirm={clearAll}
          />
        )}
      </div>
    </div>
  )
}
