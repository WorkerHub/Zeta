import { describe, it, expect, afterEach } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import QueryResults from '../../components/QueryResults'
import { t, setLocale } from '../translations'
import type { RunResults } from '../../hooks/useNotebookRuns'
import type { NotebookRunSummary, StatementResult } from '../../types'

afterEach(() => setLocale('en'))

const noop = () => {}

const run = (id: string, seq: number): NotebookRunSummary => ({
  id,
  seq,
  notebook_id: 'nb-1',
  database_id: 'db-1',
  database_name: 'one',
  sql: 'SELECT 1',
  statement_count: 1,
  row_count: 1,
  error_count: 0,
  duration_ms: 3,
  storage_truncated: 0,
  results_bytes: 10,
  executed_at: 1_760_000_000_000,
  accessible: true,
})

const rows: StatementResult[] = [{ sql: 'SELECT 1', results: [{ n: 7 }], duration_ms: 3 }]

const oldRun = run('run-1', 1)
const ready: RunResults = { status: 'ready', results: rows }

function render(props: Partial<Parameters<typeof QueryResults>[0]>) {
  return renderToStaticMarkup(
    <QueryResults
      running={false}
      runningDatabaseName=""
      runError=""
      transient={null}
      selectedRun={oldRun}
      selectedResults={ready}
      results={rows}
      activeIndex={0}
      onSelectIndex={noop}
      runList={[oldRun]}
      hasMore={false}
      listLoading={false}
      listError={false}
      onSelectRun={noop}
      onLoadMore={noop}
      onDeleteRun={noop}
      onCancelRun={noop}
      {...props}
    />
  )
}

// The results table as rendered, to compare two states' result area byte for byte
const table = (html: string) => /<table[\s\S]*?<\/table>/.exec(html)?.[0]

describe('QueryResults while a run is in flight', () => {
  it('keeps the history strip and the previous results on screen', () => {
    const html = render({ running: true, runningDatabaseName: 'one' })
    expect(html).toContain(`aria-label="${t('runs.tablist')}"`)
    expect(html).toContain('>7<') // the previous run's rows are still there
    expect(table(html)).toBe(table(render({})))
    expect(html).not.toContain(t('query.no_results'))
  })

  it('leads the strip with a spinning temporary tab for the next run', () => {
    const html = render({ running: true, runningDatabaseName: 'one' })
    // The tablist opens with the temporary tab, then the saved tabs
    const frame = '<div class="flex items-center shrink-0 rounded-md border'
    const start = html.indexOf(frame, html.indexOf(t('runs.tablist')))
    const temp = html.slice(start, html.indexOf(frame, start + 1))
    expect(temp).toContain(`title="${t('query.cancel_run')}"`)
    expect(temp).toContain('animate-spin')
    expect(temp).toContain('#2')
    // A spinner and the X only: no success/failure icon
    expect(temp.match(/<svg/g)?.length).toBe(2)
    // It cannot be selected: it is not a tab, and it is not the selected one either
    expect(temp).not.toContain('role="tab"')
    expect(temp).not.toContain('aria-selected="true"')
  })

  it('shows the running summary with the database instead of the run time', () => {
    const html = render({ running: true, runningDatabaseName: 'one' })
    const summary = html.slice(0, html.indexOf(t('runs.tablist')))
    expect(summary).toContain(t('query.running'))
    expect(summary).toContain('one')
    expect(summary).not.toContain('Ran ')
  })

  it('still shows the strip and a centered notice for a notebook without history', () => {
    const html = render({
      running: true,
      runningDatabaseName: 'one',
      selectedRun: null,
      selectedResults: null,
      results: [],
      runList: [],
    })
    expect(html).toContain(`aria-label="${t('runs.tablist')}"`)
    expect(html).toContain('#1')
    expect(html).toContain(t('query.cancel_run'))
    expect(html).toContain(t('query.running'))
    expect(html).not.toContain('<table')
  })

  it('replaces nothing when idle: no temporary tab, no running notice', () => {
    const html = render({})
    expect(html).toContain('id="run-tab-run-1"')
    expect(html).toContain('Ran ') // the normal "Ran …" summary
    expect(html).not.toContain(t('query.cancel_run'))
    expect(html).not.toContain(t('query.running'))
    expect(html).toContain('<table')
  })
})

describe('QueryResults after a run', () => {
  it('keeps the history strip when the run failed', () => {
    const html = render({ runError: 'SQL error: no such column', transient: null })
    expect(html).toContain(`aria-label="${t('runs.tablist')}"`)
    expect(html).toContain('SQL error: no such column')
    expect(html).not.toContain(t('query.cancel_run'))
    expect(html).not.toContain('<table')
  })

  it('shows results the server did not save without a strip', () => {
    const html = render({ transient: rows, selectedResults: null })
    expect(html).toContain('>7<')
    expect(html).not.toContain(`aria-label="${t('runs.tablist')}"`)
    expect(html).not.toContain(t('query.running'))
  })

  it('keeps the strip when a statement failed and the server saved nothing', () => {
    const failed: StatementResult[] = [{ sql: 'SELECT boom', results: [], duration_ms: 0, error: 'no such column' }]
    const html = render({ transient: failed, results: failed })
    expect(html).toContain(`aria-label="${t('runs.tablist')}"`)
    expect(html).toContain('no such column')
    expect(html).not.toContain(t('query.cancel_run'))
  })
})
