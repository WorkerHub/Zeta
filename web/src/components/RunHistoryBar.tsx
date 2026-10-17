import { useCallback, useEffect, useRef } from 'react'
import type { KeyboardEvent } from 'react'
import { AlertCircle, CheckCircle2, History, Loader2, Trash2, X } from 'lucide-react'
import { useLocale } from '../hooks/useLocale'
import { timeAgo } from '../lib/time'
import type { NotebookRunSummary } from '../types'

interface Props {
  runs: NotebookRunSummary[] // newest (highest number) first
  selected: NotebookRunSummary
  hasMore: boolean
  loading: boolean
  loadError: boolean
  onSelect: (runId: string) => void
  onLoadMore: () => void
  onDelete: (runId: string) => void
  onClear: () => void
}

// How close (px) to the oldest end of the strip the next page of older runs is loaded
const LOAD_MORE_MARGIN = 64
const TOOLTIP_SQL_LENGTH = 200

// The notebook's saved runs as a strip of tabs, numbered … #3 #2 #1 from right to left: the
// newest run is on the left, the first one on the right. It scrolls sideways (trackpad, touch,
// mouse wheel); older runs are loaded on reaching the right end.
export default function RunHistoryBar({
  runs,
  selected,
  hasMore,
  loading,
  loadError,
  onSelect,
  onLoadMore,
  onDelete,
  onClear,
}: Props) {
  const { t, locale } = useLocale()
  const scrollerRef = useRef<HTMLDivElement>(null)
  const tabRefs = useRef(new Map<string, HTMLButtonElement>())
  // Set by keyboard actions so focus follows the selected tab; never moved on load or click
  const focusSelected = useRef(false)

  const loadMoreAtEnd = useCallback(() => {
    const sc = scrollerRef.current
    if (!sc || !hasMore || loading) return
    if (sc.scrollLeft + sc.clientWidth >= sc.scrollWidth - LOAD_MORE_MARGIN) onLoadMore()
  }, [hasMore, loading, onLoadMore])

  // Also after each page (loadMoreAtEnd changes once it is in), so a strip too short to scroll
  // still fills up; after a failed page only on scrolling, so an error does not retry in a loop
  useEffect(() => {
    if (!loadError) loadMoreAtEnd()
  }, [loadError, loadMoreAtEnd])

  // Keep the selected tab in view (the newest when a notebook opens or a run finishes)
  useEffect(() => {
    const sc = scrollerRef.current
    const tab = tabRefs.current.get(selected.id)
    const box = tab?.parentElement
    if (!sc || !tab || !box) return
    const left = box.offsetLeft
    const right = left + box.offsetWidth
    if (left < sc.scrollLeft) sc.scrollLeft = left - 8
    else if (right > sc.scrollLeft + sc.clientWidth) sc.scrollLeft = right - sc.clientWidth + 8
    if (focusSelected.current) {
      focusSelected.current = false
      tab.focus()
    }
  }, [selected.id])

  // A plain mouse wheel scrolls the strip sideways. Trackpads, tilt wheels and Shift+wheel already
  // scroll it horizontally; at either end the page scrolls as usual.
  useEffect(() => {
    const sc = scrollerRef.current
    if (!sc) return
    const onWheel = (e: WheelEvent) => {
      if (e.shiftKey || Math.abs(e.deltaX) >= Math.abs(e.deltaY)) return
      const unit =
        e.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : e.deltaMode === WheelEvent.DOM_DELTA_PAGE ? sc.clientWidth : 1
      const from = sc.scrollLeft
      sc.scrollLeft += e.deltaY * unit
      if (sc.scrollLeft !== from) e.preventDefault()
    }
    sc.addEventListener('wheel', onWheel, { passive: false })
    return () => sc.removeEventListener('wheel', onWheel)
  }, [])

  const ago = (run: NotebookRunSummary) => timeAgo(Math.floor(run.executed_at / 1000), locale)
  const outcome = (run: NotebookRunSummary) =>
    run.error_count > 0
      ? t('runs.errors', { n: run.error_count })
      : t(run.row_count === 1 ? 'results.row' : 'results.rows', { n: run.row_count })
  const tooltip = (run: NotebookRunSummary) =>
    [
      `#${run.seq} · ${new Date(run.executed_at).toLocaleString()}`,
      run.database_name && t('runs.database', { name: run.database_name }),
      outcome(run),
      run.sql.length > TOOLTIP_SQL_LENGTH ? `${run.sql.slice(0, TOOLTIP_SQL_LENGTH)}…` : run.sql,
    ]
      .filter(Boolean)
      .join('\n')

  // Left = newer, right = older, as on screen
  function onTabKeyDown(e: KeyboardEvent<HTMLButtonElement>, index: number) {
    let next: number
    switch (e.key) {
      case 'ArrowLeft':
        next = index - 1
        break
      case 'ArrowRight':
        next = index + 1
        if (next >= runs.length && hasMore && !loading) onLoadMore()
        break
      case 'Home':
        next = 0
        break
      case 'End':
        next = runs.length - 1
        break
      case 'Delete':
      case 'Backspace':
        e.preventDefault()
        focusSelected.current = true
        onDelete(runs[index]!.id)
        return
      default:
        return
    }
    e.preventDefault()
    const run = runs[Math.min(Math.max(next, 0), runs.length - 1)]
    if (!run || run.id === selected.id) return
    focusSelected.current = true
    onSelect(run.id)
  }

  return (
    <div className="shrink-0 border-b border-zinc-200 dark:border-zinc-800">
      <div className="flex items-center gap-2 px-3 py-1 text-xs text-zinc-500 min-w-0">
        <History size={12} className="text-zinc-400 shrink-0" />
        <span
          className="hidden sm:block truncate min-w-0 max-w-[40%]"
          title={new Date(selected.executed_at).toLocaleString()}
        >
          {t('runs.ran_at', { time: ago(selected) })}
          {selected.database_name && ` · ${selected.database_name}`} · {outcome(selected)}
        </span>
        <div
          ref={scrollerRef}
          onScroll={loadMoreAtEnd}
          className="relative flex flex-1 min-w-0 overflow-x-auto overscroll-x-contain py-0.5 [scrollbar-width:thin]"
        >
          {/* ml-auto keeps a short strip at the right; a long one overflows to the right and scrolls */}
          <div className="ml-auto flex items-center gap-1 shrink-0">
            <div role="tablist" aria-label={t('runs.tablist')} className="flex items-center gap-1">
              {runs.map((run, index) => {
                const active = run.id === selected.id
                const failed = run.error_count > 0
                return (
                  <div
                    key={run.id}
                    className={`flex items-center shrink-0 rounded-md border ${
                      active
                        ? 'border-blue-300 bg-blue-50 text-blue-700 dark:border-blue-800 dark:bg-blue-950/40 dark:text-blue-300'
                        : 'border-transparent text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800'
                    }`}
                  >
                    <button
                      type="button"
                      role="tab"
                      id={`run-tab-${run.id}`}
                      aria-selected={active}
                      tabIndex={active ? 0 : -1}
                      ref={(el) => {
                        if (el) tabRefs.current.set(run.id, el)
                        else tabRefs.current.delete(run.id)
                      }}
                      onClick={() => onSelect(run.id)}
                      onKeyDown={(e) => onTabKeyDown(e, index)}
                      title={tooltip(run)}
                      className="flex items-center gap-1 pl-1.5 pr-1 py-0.5 rounded-md font-mono tabular-nums focus-visible:outline-2 focus-visible:outline-blue-500"
                    >
                      {failed ? (
                        <AlertCircle size={11} className="text-red-400 shrink-0" aria-hidden="true" />
                      ) : (
                        <CheckCircle2 size={11} className="text-emerald-400 shrink-0" aria-hidden="true" />
                      )}
                      <span className="sr-only">{t(failed ? 'runs.failed' : 'runs.succeeded')}</span>#{run.seq}
                    </button>
                    {/* Keyboard users delete the focused tab with Delete / Backspace */}
                    <button
                      type="button"
                      tabIndex={-1}
                      onClick={() => onDelete(run.id)}
                      className="mr-0.5 p-0.5 rounded text-zinc-400 hover:text-red-400 hover:bg-zinc-200/70 dark:hover:bg-zinc-700"
                      title={t('runs.delete_run', { n: run.seq })}
                      aria-label={t('runs.delete_run', { n: run.seq })}
                    >
                      <X size={10} />
                    </button>
                  </div>
                )
              })}
            </div>
            {hasMore &&
              (loading ? (
                <Loader2 size={12} className="animate-spin text-zinc-400 shrink-0 mx-1" />
              ) : (
                <button
                  type="button"
                  onClick={onLoadMore}
                  className="shrink-0 px-1.5 py-0.5 rounded text-blue-500 hover:bg-zinc-100 dark:hover:bg-zinc-800"
                >
                  {t('runs.load_more')}
                </button>
              ))}
          </div>
        </div>
        <button
          type="button"
          onClick={() => {
            if (window.confirm(t('runs.clear_confirm'))) onClear()
          }}
          className="flex items-center gap-1 shrink-0 pl-2 ml-1 border-l border-zinc-200 dark:border-zinc-800 text-zinc-400 hover:text-red-400"
          title={t('runs.clear')}
          aria-label={t('runs.clear')}
        >
          <Trash2 size={12} />
          <span className="hidden sm:inline">{t('runs.clear_all')}</span>
        </button>
      </div>
      {selected.storage_truncated > 0 && (
        <p className="px-3 pb-1.5 text-xs text-amber-500">{t('runs.storage_truncated')}</p>
      )}
    </div>
  )
}
