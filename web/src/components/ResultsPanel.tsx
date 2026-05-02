import { AlertCircle, CheckCircle2 } from 'lucide-react'
import type { StatementResult } from '../types'
import ResultTable from './ResultTable'

interface Props {
  results: StatementResult[]
  activeIndex: number
  onSelectIndex: (i: number) => void
}

export default function ResultsPanel({ results, activeIndex, onSelectIndex }: Props) {
  const active = results[activeIndex]
  if (!active) return null

  return (
    <div className="flex h-full overflow-hidden">
      {/* Left sidebar — only shown when there are multiple results */}
      {results.length > 1 && (
        <div className="w-[130px] shrink-0 border-r border-zinc-200 dark:border-zinc-800 flex flex-col overflow-y-auto">
          <div className="px-2 py-1.5 text-[10px] text-zinc-500 dark:text-zinc-600 uppercase tracking-wider border-b border-zinc-200 dark:border-zinc-800 shrink-0">
            {results.length} results
          </div>
          {results.map((r, i) => {
            const isActive = i === activeIndex
            const hasError = !!r.error
            const meta = hasError
              ? 'error'
              : r.results.length > 0
              ? `${r.results.length}r`
              : r.changes !== undefined
              ? `${r.changes}c`
              : '0r'
            return (
              <button
                key={i}
                onClick={() => onSelectIndex(i)}
                className={`w-full text-left px-2.5 py-2 border-b border-zinc-100 dark:border-zinc-800/50 transition-colors ${
                  isActive
                    ? 'bg-blue-50 dark:bg-blue-950/30 border-l-2 border-l-blue-500'
                    : 'hover:bg-zinc-50 dark:hover:bg-zinc-800/50'
                }`}
              >
                <div className="flex items-center gap-1 mb-0.5">
                  {hasError
                    ? <AlertCircle size={10} className="text-red-400 shrink-0" />
                    : <CheckCircle2 size={10} className="text-emerald-400 shrink-0" />
                  }
                  <span className={`text-[10px] ${isActive ? 'text-zinc-600 dark:text-zinc-300' : 'text-zinc-500 dark:text-zinc-500'}`}>
                    #{i + 1} · {meta} · {r.duration_ms}ms
                  </span>
                </div>
                <div className="text-[10px] text-zinc-400 dark:text-zinc-600 truncate font-mono">{r.sql}</div>
              </button>
            )
          })}
        </div>
      )}

      {/* Right content area */}
      <div className="flex-1 flex flex-col overflow-hidden min-w-0">
        {/* SQL source header */}
        <div className="px-3 py-2 border-b border-zinc-200 dark:border-zinc-800 shrink-0 flex items-center gap-2 min-w-0">
          <span className="text-[10px] uppercase tracking-wider text-zinc-400 dark:text-zinc-600 shrink-0">SQL</span>
          <code className="text-xs text-zinc-500 dark:text-zinc-400 truncate font-mono">{active.sql}</code>
        </div>

        {/* Meta line */}
        <div className="px-3 py-1.5 border-b border-zinc-100 dark:border-zinc-800/50 shrink-0 flex items-center gap-2">
          {active.error ? (
            <>
              <AlertCircle size={12} className="text-red-400 shrink-0" />
              <span className="text-xs text-red-400">Error</span>
              <span className="text-zinc-300 dark:text-zinc-600 text-xs">·</span>
              <span className="text-xs text-zinc-500">{active.duration_ms}ms</span>
            </>
          ) : (
            <>
              <CheckCircle2 size={12} className="text-emerald-400 shrink-0" />
              <span className="text-xs text-emerald-500">
                {active.results.length > 0
                  ? `${active.results.length} ${active.results.length === 1 ? 'row' : 'rows'}`
                  : active.changes !== undefined
                  ? `${active.changes} ${active.changes === 1 ? 'change' : 'changes'}`
                  : '0 rows'}
              </span>
              <span className="text-zinc-300 dark:text-zinc-600 text-xs">·</span>
              <span className="text-xs text-zinc-500">{active.duration_ms}ms</span>
            </>
          )}
        </div>

        {/* Result content */}
        <div className="flex-1 overflow-auto p-3">
          {active.error ? (
            <div className="flex items-start gap-3 p-4 bg-red-500/10 border border-red-500/20 rounded-xl">
              <AlertCircle size={16} className="text-red-400 shrink-0 mt-0.5" />
              <pre className="text-xs text-red-300 whitespace-pre-wrap font-mono">{active.error}</pre>
            </div>
          ) : (
            <ResultTable rows={active.results} />
          )}
        </div>
      </div>
    </div>
  )
}
