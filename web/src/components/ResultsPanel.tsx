import { AlertCircle, CheckCircle2 } from 'lucide-react'
import type { StatementResult } from '../types'
import ResultTable from './ResultTable'
import { useLocale } from '../hooks/useLocale'
import { MAX_RESULT_ROWS } from '../lib/sql'

interface Props {
  results: StatementResult[]
  activeIndex: number
  onSelectIndex: (i: number) => void
}

export default function ResultsPanel({ results, activeIndex, onSelectIndex }: Props) {
  const { t } = useLocale()
  const active = results[activeIndex]
  if (!active) return null

  return (
    <div className="flex h-full overflow-hidden">
      {/* Left sidebar — only shown when there are multiple results */}
      {results.length > 1 && (
        <div className="w-[130px] shrink-0 border-r border-ink-200 flex flex-col overflow-y-auto">
          <div className="px-2 py-1.5 text-micro text-ink-500 uppercase border-b border-ink-200 shrink-0">
            {t('results.count', { n: results.length })}
          </div>
          {results.map((r, i) => {
            const isActive = i === activeIndex
            const hasError = !!r.error
            const meta = hasError
              ? t('results.error_short')
              : r.results.length > 0
                ? `${r.results.length}r`
                : r.changes !== undefined
                  ? `${r.changes}c`
                  : '0r'
            return (
              <button
                type="button"
                // biome-ignore lint/suspicious/noArrayIndexKey: one entry per executed statement; its position is its identity
                key={i}
                onClick={() => onSelectIndex(i)}
                className={`w-full text-left px-2.5 py-2 border-b border-ink-100 transition-colors duration-(--duration-fast) ease-(--ease-standard) ${
                  isActive ? 'bg-brand-50 border-l-2 border-l-brand-600' : 'hover:bg-ink-50'
                }`}
              >
                <div className="flex items-center gap-1 mb-0.5">
                  {hasError ? (
                    <AlertCircle size={10} className="text-danger-600 shrink-0" />
                  ) : (
                    <CheckCircle2 size={10} className="text-success-600 shrink-0" />
                  )}
                  <span className={`text-micro tnum ${isActive ? 'text-ink-700' : 'text-ink-500'}`}>
                    #{i + 1} · {meta} · {r.duration_ms}ms
                  </span>
                </div>
                <div className="text-micro text-ink-400 truncate font-mono">{r.sql}</div>
              </button>
            )
          })}
        </div>
      )}

      {/* Right content area */}
      <div className="flex-1 flex flex-col overflow-hidden min-w-0">
        {/* SQL source header */}
        <div className="px-3 py-2 border-b border-ink-200 shrink-0 flex items-center gap-2 min-w-0">
          <span className="text-micro uppercase text-ink-400 shrink-0">SQL</span>
          <code className="text-caption text-ink-500 truncate font-mono">{active.sql}</code>
        </div>

        {/* Meta line */}
        <div className="px-3 py-1.5 border-b border-ink-100 shrink-0 flex items-center gap-2">
          {active.error ? (
            <>
              <AlertCircle size={12} className="text-danger-600 shrink-0" />
              <span className="text-caption text-danger-600">{t('results.error')}</span>
              <span className="text-ink-300 text-caption">·</span>
              <span className="text-caption text-ink-500 tnum">{active.duration_ms}ms</span>
            </>
          ) : (
            <>
              <CheckCircle2 size={12} className="text-success-600 shrink-0 animate-success-pop" />
              <span className="text-caption text-success-600 tnum">
                {active.results.length > 0
                  ? t(active.results.length === 1 ? 'results.row' : 'results.rows', { n: active.results.length })
                  : active.changes !== undefined
                    ? t(active.changes === 1 ? 'results.change' : 'results.changes', { n: active.changes })
                    : t('results.rows', { n: 0 })}
              </span>
              {active.truncated && (
                <span className="text-caption text-warning-600 tnum">
                  {t('results.truncated', { n: MAX_RESULT_ROWS })}
                </span>
              )}
              {active.stored_rows !== undefined && (
                <span className="text-caption text-warning-600 tnum">
                  {t('results.stored_rows', { n: active.stored_rows })}
                </span>
              )}
              <span className="text-ink-300 text-caption">·</span>
              <span className="text-caption text-ink-500 tnum">{active.duration_ms}ms</span>
            </>
          )}
        </div>

        {/* Result content */}
        <div className="flex-1 overflow-auto p-3">
          {active.error ? (
            <div className="flex items-start gap-3 p-4 bg-danger-50 border border-danger-200 rounded-lg">
              <AlertCircle size={16} className="text-danger-600 shrink-0 mt-0.5" />
              <pre className="text-caption text-danger-600 whitespace-pre-wrap font-mono">{active.error}</pre>
            </div>
          ) : (
            <ResultTable rows={active.results} />
          )}
        </div>
      </div>
    </div>
  )
}
