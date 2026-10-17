import { useEffect, useRef, useState } from 'react'
import { AlertCircle, CheckCircle2, ChevronDown, History, Loader2, Trash2 } from 'lucide-react'
import { useLocale } from '../hooks/useLocale'
import { timeAgo } from '../lib/time'
import type { NotebookRunSummary } from '../types'

interface Props {
  runs: NotebookRunSummary[]
  selected: NotebookRunSummary
  hasMore: boolean
  loading: boolean
  onSelect: (runId: string) => void
  onLoadMore: () => void
  onDelete: (runId: string) => void
  onClear: () => void
}

// Which saved run the results panel shows, and the notebook's other saved runs
export default function RunHistoryBar({
  runs,
  selected,
  hasMore,
  loading,
  onSelect,
  onLoadMore,
  onDelete,
  onClear,
}: Props) {
  const { t, locale } = useLocale()
  const [open, setOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function handleClick(e: MouseEvent) {
      if (!menuRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [open])

  const ago = (run: NotebookRunSummary) => timeAgo(Math.floor(run.executed_at / 1000), locale)
  const outcome = (run: NotebookRunSummary) =>
    run.error_count > 0
      ? t('runs.errors', { n: run.error_count })
      : t(run.row_count === 1 ? 'results.row' : 'results.rows', { n: run.row_count })

  return (
    <div className="shrink-0 border-b border-zinc-200 dark:border-zinc-800">
      <div className="flex items-center gap-2 px-3 py-1.5 text-xs text-zinc-500 min-w-0">
        <History size={12} className="text-zinc-400 shrink-0" />
        <span className="truncate" title={new Date(selected.executed_at).toLocaleString()}>
          {t('runs.ran_at', { time: ago(selected) })}
          {selected.database_name && ` · ${selected.database_name}`} · {outcome(selected)}
        </span>
        <div className="flex-1" />
        <div className="relative shrink-0" ref={menuRef}>
          <button
            type="button"
            onClick={() => setOpen(!open)}
            className="flex items-center gap-1 px-2 py-0.5 rounded hover:bg-zinc-100 dark:hover:bg-zinc-800 text-zinc-600 dark:text-zinc-300"
          >
            {t('runs.history', { n: hasMore ? `${runs.length}+` : runs.length })}
            <ChevronDown size={12} />
          </button>
          {open && (
            <div className="absolute right-0 top-full mt-1 w-80 max-h-96 overflow-y-auto bg-white border border-zinc-200 dark:bg-zinc-900 dark:border-zinc-700 rounded-xl shadow-xl z-20">
              {runs.map((run) => (
                <button
                  type="button"
                  key={run.id}
                  onClick={() => {
                    onSelect(run.id)
                    setOpen(false)
                  }}
                  className={`w-full text-left px-3 py-2 border-b border-zinc-100 dark:border-zinc-800/50 hover:bg-zinc-50 dark:hover:bg-zinc-800/50 ${
                    run.id === selected.id ? 'bg-blue-50 dark:bg-blue-950/30' : ''
                  }`}
                >
                  <div className="flex items-center gap-1.5 text-[11px] text-zinc-500">
                    {run.error_count > 0 ? (
                      <AlertCircle size={11} className="text-red-400 shrink-0" />
                    ) : (
                      <CheckCircle2 size={11} className="text-emerald-400 shrink-0" />
                    )}
                    <span>{ago(run)}</span>
                    <span className="text-zinc-300 dark:text-zinc-600">·</span>
                    <span>{outcome(run)}</span>
                    {run.database_name && (
                      <>
                        <span className="text-zinc-300 dark:text-zinc-600">·</span>
                        <span className="truncate">{run.database_name}</span>
                      </>
                    )}
                  </div>
                  <div className="text-xs text-zinc-600 dark:text-zinc-400 font-mono truncate">{run.sql}</div>
                </button>
              ))}
              {hasMore && (
                <button
                  type="button"
                  onClick={onLoadMore}
                  disabled={loading}
                  className="w-full flex items-center justify-center gap-1.5 px-3 py-2 text-xs text-blue-500 hover:bg-zinc-50 dark:hover:bg-zinc-800/50 disabled:opacity-50"
                >
                  {loading && <Loader2 size={12} className="animate-spin" />}
                  {t('runs.load_more')}
                </button>
              )}
              <button
                type="button"
                onClick={() => {
                  if (!window.confirm(t('runs.clear_confirm'))) return
                  setOpen(false)
                  onClear()
                }}
                className="w-full px-3 py-2 text-xs text-left text-red-400 hover:bg-zinc-50 dark:hover:bg-zinc-800/50"
              >
                {t('runs.clear')}
              </button>
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={() => onDelete(selected.id)}
          className="p-1 rounded text-zinc-400 hover:text-red-400 hover:bg-zinc-100 dark:hover:bg-zinc-800 shrink-0"
          title={t('runs.delete')}
          aria-label={t('runs.delete')}
        >
          <Trash2 size={12} />
        </button>
      </div>
      {selected.storage_truncated > 0 && (
        <p className="px-3 pb-1.5 text-xs text-amber-500">{t('runs.storage_truncated')}</p>
      )}
    </div>
  )
}
