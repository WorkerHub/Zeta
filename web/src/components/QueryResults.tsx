import { AlertCircle, AlertTriangle, CircleSlash, Loader2 } from 'lucide-react'
import { useLocale } from '../hooks/useLocale'
import type { CancelNotice, HaltNotice } from '../lib/runs'
import { stripLeadingCommentsForDisplay } from '../lib/sql'
import type { RunResults } from '../hooks/useNotebookRuns'
import type { NotebookRunSummary, StatementResult } from '../types'
import ResultsPanel from './ResultsPanel'
import RunHistoryBar from './RunHistoryBar'

interface Props {
  running: boolean
  runningDatabaseName: string
  runningSql: string
  runningStatementCount: number
  /** The shown run was cancelled by the user (the engine caveat rides along when it is known). */
  cancelled?: CancelNotice | null
  /** The shown run was a batch that stopped at a failing statement. */
  halted?: HaltNotice | null
  runError: string
  transient: StatementResult[] | null
  selectedRun: NotebookRunSummary | null
  selectedResults: RunResults | null
  results: StatementResult[]
  activeIndex: number
  onSelectIndex: (index: number) => void
  runList: NotebookRunSummary[]
  hasMore: boolean
  listLoading: boolean
  listError: boolean
  onSelectRun: (runId: string) => void
  onLoadMore: () => void
  onDeleteRun: (runId: string) => void
  onCancelRun: () => void
}

// The results half of the query page: the run history strip and the results below it.
//
// A run in flight must not take the panel away — the previously selected run's results and the
// strip (scrolled where the user left it) stay on screen, and only the strip gains a temporary tab.
// That is why neither branch is gated on !running here: both keep their place in the tree while a
// query runs, so React never unmounts and re-mounts them. The run in flight is named on a mask the
// panel draws over itself; the centered notice is only for a notebook with nothing to show yet
// (its first run).
export default function QueryResults({
  running,
  runningDatabaseName,
  runningSql,
  runningStatementCount,
  cancelled = null,
  halted = null,
  runError,
  transient,
  selectedRun,
  selectedResults,
  results,
  activeIndex,
  onSelectIndex,
  runList,
  hasMore,
  listLoading,
  listError,
  onSelectRun,
  onLoadMore,
  onDeleteRun,
  onCancelRun,
}: Props) {
  const { t } = useLocale()

  // What the run in flight is executing: its first statement, with how many it submitted. The old
  // results stay mounted underneath; this is the only text the mask (and the first-run notice)
  // shows while they are hidden. The statement itself, not the comments above it.
  const runningLabel = t(runningStatementCount > 1 ? 'results.running_sql_statements' : 'results.running_sql', {
    sql: stripLeadingCommentsForDisplay(runningSql),
    n: runningStatementCount,
  })

  // Results the server did not store (a run it did not name) take the saved run's place in the
  // panel, so the strip steps aside. A failure is different: it must be visible *and* leave the run
  // history in place, so only a run whose every statement succeeded hides the strip.
  const unsavedSuccess = transient?.every((result) => !result.error) ?? false

  return (
    <>
      {(running || (selectedRun && !unsavedSuccess)) && (
        <RunHistoryBar
          runs={runList}
          selected={selectedRun}
          running={running}
          runningDatabaseName={runningDatabaseName}
          hasMore={hasMore}
          loading={listLoading}
          loadError={listError}
          onSelect={onSelectRun}
          onLoadMore={onLoadMore}
          onDelete={onDeleteRun}
          onCancelRun={onCancelRun}
        />
      )}
      {runError ? (
        <div className="m-4 flex items-start gap-3 p-4 bg-danger-50 border border-danger-200 rounded-lg">
          <AlertCircle size={18} className="text-danger-600 shrink-0 mt-0.5" />
          <div>
            <p className="text-body-strong text-danger-600 mb-1">{t('query.error')}</p>
            <pre className="text-caption text-danger-700 whitespace-pre-wrap font-mono">{runError}</pre>
          </div>
        </div>
      ) : (
        <>
          {/* A run the user cancelled: one line above the results it left behind, saying what stopped
              and — for an engine that can only stop the batch (D1, TiDB) — that the statement in
              flight still finishes on the server. Hidden while another run is in flight. */}
          {cancelled && !running && (
            <div className="mx-4 mt-3 flex items-start gap-1.5 text-caption text-ink-700 shrink-0">
              <CircleSlash size={13} className="mt-0.5 shrink-0 text-ink-400" aria-hidden="true" />
              <span className="min-w-0">
                {t('results.cancelled')}
                {cancelled.caveat && <span className="block text-ink-500">{t('results.cancelled_caveat')}</span>}
              </span>
            </div>
          )}
          {/* A batch that stopped at its failing statement: one line above the results it left
              behind, naming the statement that failed and what never ran. Hidden while another
              run is in flight — the mask covers the panel those results belong to. */}
          {halted && !running && (
            <p className="mx-4 mt-3 flex items-start gap-1.5 text-caption text-warning-600 shrink-0">
              <AlertTriangle size={13} className="mt-0.5 shrink-0" aria-hidden="true" />
              <span className="min-w-0">{t('results.halted', { n: halted.failedAt, m: halted.remaining })}</span>
            </p>
          )}
          {/* Always present, so entering and leaving a run never changes the panel's box */}
          <div className="flex-1 overflow-hidden">
            {results.length > 0 ? (
              <ResultsPanel
                results={results}
                activeIndex={activeIndex}
                onSelectIndex={onSelectIndex}
                running={running}
                runningLabel={runningLabel}
              />
            ) : running ? (
              <div
                role="status"
                className="flex flex-col items-center justify-center h-full gap-1.5 overflow-hidden px-4 text-ink-500"
              >
                <span className="flex items-center gap-2 min-w-0">
                  <Loader2 size={18} className="animate-spin shrink-0" aria-hidden="true" />
                  <span className="min-w-0 text-body truncate" title={runningLabel}>
                    {runningLabel}
                  </span>
                </span>
              </div>
            ) : selectedResults && selectedResults.status !== 'ready' ? (
              <div className="flex items-center justify-center h-full gap-2 px-4 text-center text-body text-ink-400">
                {selectedResults.status === 'loading' && <Loader2 size={16} className="animate-spin" />}
                {selectedResults.status === 'loading'
                  ? t('runs.loading')
                  : selectedResults.status === 'denied'
                    ? t('runs.access_denied')
                    : t('runs.load_failed')}
              </div>
            ) : !transient && !selectedRun ? (
              <div className="flex items-center justify-center h-full text-ink-400 text-body">
                {listLoading ? t('common.loading') : listError ? t('runs.list_failed') : t('query.no_results')}
              </div>
            ) : null}
          </div>
        </>
      )}
    </>
  )
}
