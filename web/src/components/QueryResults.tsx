import { AlertCircle, Loader2 } from 'lucide-react'
import { useLocale } from '../hooks/useLocale'
import type { RunResults } from '../hooks/useNotebookRuns'
import type { NotebookRunSummary, StatementResult } from '../types'
import ResultsPanel from './ResultsPanel'
import RunHistoryBar from './RunHistoryBar'

interface Props {
  running: boolean
  runningDatabaseName: string
  runningSql: string
  runningStatementCount: number
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
  // shows while they are hidden.
  const runningLabel = t(runningStatementCount > 1 ? 'results.running_sql_statements' : 'results.running_sql', {
    sql: runningSql,
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
        // Always present, so entering and leaving a run never changes the panel's box
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
            <div role="status" className="flex items-center justify-center h-full gap-2 px-4 min-w-0 text-ink-500">
              <Loader2 size={18} className="animate-spin shrink-0" aria-hidden="true" />
              <span className="text-body truncate" title={runningLabel}>
                {runningLabel}
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
      )}
    </>
  )
}
