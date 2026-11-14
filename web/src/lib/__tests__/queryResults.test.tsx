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
      runningSql=""
      runningStatementCount={0}
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

describe('QueryResults after a batch that halted', () => {
  // Three statements submitted, two attempted, the second one failed
  const partial: StatementResult[] = [
    { sql: 'SELECT 1', results: [{ n: 1 }], duration_ms: 2 },
    { sql: 'SELECT boom', results: [], duration_ms: 0, error: 'no such column: boom' },
  ]
  const halted = { failedAt: 2, remaining: 1 }

  it('names the failing statement and what never ran, above the results it left', () => {
    const html = render({ results: partial, halted, selectedResults: { status: 'ready', results: partial, halted } })
    expect(html).toContain(t('results.halted', { n: 2, m: 1 }))
    expect(html.indexOf(t('results.halted', { n: 2, m: 1 }))).toBeLessThan(html.indexOf('<table'))
    // Both attempted statements are there, the failing one carrying its error
    expect(html).toContain('SELECT boom')
    expect(html).toContain(`<span class="text-micro tnum text-ink-500">#2 · ${t('results.error_short')} · 0ms</span>`)
  })

  it('says nothing about a run that completed', () => {
    const html = render({})
    expect(html).not.toContain(t('results.halted', { n: 1, m: 1 }))
    expect(html).not.toContain('did not run')
  })

  it('says nothing while another run is in flight', () => {
    const html = render({ results: partial, halted, running: true, runningDatabaseName: 'one' })
    expect(html).not.toContain(t('results.halted', { n: 2, m: 1 }))
  })

  it('shows the notice for results the server did not name as well', () => {
    const html = render({ transient: partial, results: partial, halted, selectedResults: null, selectedRun: null })
    expect(html).toContain(t('results.halted', { n: 2, m: 1 }))
  })

  it('shows the notice in Chinese with the same numbers', () => {
    setLocale('zh')
    const html = render({ results: partial, halted, selectedResults: { status: 'ready', results: partial, halted } })
    expect(html).toContain('第 2 条语句出错，已停止，其余 1 条未执行')
  })
})

describe('QueryResults for a cancelled run', () => {
  // A batch cancelled while its second statement ran: the first one's rows survive
  const batch: StatementResult[] = [
    { sql: 'SELECT 1', results: [{ n: 1 }], duration_ms: 2 },
    { sql: 'SELECT SLEEP(30)', results: [], duration_ms: 1500, cancelled: true },
  ]
  const caveat = { caveat: true }
  const killed = { caveat: false }

  it('says the execution was cancelled, above the results it left behind', () => {
    const html = render({
      results: batch,
      cancelled: caveat,
      selectedResults: { status: 'ready', results: batch, cancelled: caveat },
    })
    expect(html).toContain(t('results.cancelled'))
    expect(html).toContain(t('results.cancelled_caveat'))
    expect(html.indexOf(t('results.cancelled'))).toBeLessThan(html.indexOf('<table'))
    expect(html).toContain('>1<') // the statement that had already finished keeps its rows
  })

  it('leaves the caveat out for an engine that really kills the statement', () => {
    const html = render({
      results: batch,
      cancelled: killed,
      selectedResults: { status: 'ready', results: batch, cancelled: killed },
    })
    expect(html).toContain(t('results.cancelled'))
    expect(html).not.toContain(t('results.cancelled_caveat'))
  })

  it('says nothing for a run that was not cancelled', () => {
    const html = render({})
    expect(html).not.toContain(t('results.cancelled'))
    expect(html).not.toContain(t('results.cancelled_short'))
  })

  it('says nothing while another run is in flight', () => {
    const html = render({ results: batch, cancelled: caveat, running: true, runningDatabaseName: 'one' })
    expect(html).not.toContain(t('results.cancelled'))
  })

  it('marks the statement it stopped as cancelled, not as a success', () => {
    const html = render({ results: batch, activeIndex: 1, cancelled: caveat })
    expect(html).toContain(`#2 · ${t('results.cancelled_short')} · 1500ms`)
    // Neither the success mark nor an error: the body says the execution was cancelled
    expect(html).not.toContain('animate-success-pop')
    expect(html).toContain(t('results.cancelled'))
  })

  it('shows the notice for results the server did not name as well', () => {
    const html = render({
      transient: batch,
      results: batch,
      cancelled: caveat,
      selectedResults: null,
      selectedRun: null,
    })
    expect(html).toContain(t('results.cancelled_caveat'))
  })

  it('carries the Chinese wording verbatim', () => {
    setLocale('zh')
    const html = render({
      results: batch,
      cancelled: caveat,
      selectedResults: { status: 'ready', results: batch, cancelled: caveat },
    })
    expect(html).toContain('已取消执行')
    expect(html).toContain('本条语句仍在服务端跑完，其余语句不再执行')
  })
})

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
      runningSql: 'SELECT 1',
      runningStatementCount: 1,
      selectedRun: null,
      selectedResults: null,
      results: [],
      runList: [],
    })
    expect(html).toContain(`aria-label="${t('runs.tablist')}"`)
    expect(html).toContain('#1')
    expect(html).toContain(t('query.cancel_run'))
    expect(html).toContain(t('query.running')) // the strip's summary
    // The centered notice names the SQL it is running, like the mask does
    expect(html).toContain(t('results.running_sql', { sql: 'SELECT 1' }))
    expect(html).toContain('role="status"')
    expect(html).not.toContain('<table')
  })

  it('masks the whole panel with the SQL it is running, keeping the previous results underneath', () => {
    const html = render({ running: true, runningDatabaseName: 'one', runningSql: 'SELECT 1', runningStatementCount: 1 })
    const label = t('results.running_sql', { sql: 'SELECT 1' })
    expect(html).toContain(label)
    // A single status region on screen (the first-run notice is the other branch), and the mask
    // is drawn after the SQL header row it covers
    expect(html.match(/role="status"/g)?.length).toBe(1)
    expect(html.indexOf(label)).toBeGreaterThan(html.indexOf('>SQL<'))
    // The results underneath are untouched, so the mask disappears onto them
    expect(table(html)).toBe(table(render({})))
  })

  it('names every statement when the run submitted several', () => {
    const html = render({ running: true, runningSql: 'SELECT 1', runningStatementCount: 3 })
    expect(html).toContain(t('results.running_sql_statements', { sql: 'SELECT 1', n: 3 }))
    expect(html).not.toContain(t('results.running_sql_statements', { sql: 'SELECT 1', n: 2 }))
  })

  // The label is the same text on the mask and on the first-run notice: both start at the statement
  it('names the statement it is running, not the comments above it', () => {
    const runningSql = '-- 注释\nshow tables'
    const props = { running: true, runningSql, runningStatementCount: 2 }
    const masked = render(props)
    expect(masked).toContain(t('results.running_sql_statements', { sql: 'show tables', n: 2 }))
    expect(masked).not.toContain('-- 注释')
    // The first-run notice (no results yet) carries the stripped label too
    const first = render({ ...props, selectedRun: null, selectedResults: null, results: [], runList: [] })
    expect(first).toContain(t('results.running_sql_statements', { sql: 'show tables', n: 2 }))
    expect(first).not.toContain('-- 注释')
  })

  it('falls back to the stored text when the running statement is nothing but comments', () => {
    const html = render({ running: true, runningSql: '-- 只有注释', runningStatementCount: 1 })
    expect(html).toContain(t('results.running_sql', { sql: '-- 只有注释' }))
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
  it('drops the mask and shows the new results once the run finished', () => {
    const fresh: StatementResult[] = [{ sql: 'SELECT 2', results: [{ n: 9 }], duration_ms: 5 }]
    const next = run('run-2', 2)
    const html = render({
      runningSql: 'SELECT 2',
      runningStatementCount: 1,
      selectedRun: next,
      selectedResults: { status: 'ready', results: fresh },
      results: fresh,
      runList: [next, oldRun],
    })
    expect(html).not.toContain(t('results.running_sql', { sql: 'SELECT 2' }))
    expect(html).not.toContain('role="status"')
    expect(html).toContain('>9<')
  })

  it('drops the mask when a cancelled run lands its own result', () => {
    const stopped: StatementResult[] = [{ sql: 'SELECT SLEEP(30)', results: [], duration_ms: 1500, cancelled: true }]
    const next = run('run-2', 2)
    const notice = { caveat: true }
    const html = render({
      runningSql: 'SELECT SLEEP(30)',
      runningStatementCount: 1,
      selectedRun: next,
      selectedResults: { status: 'ready', results: stopped, cancelled: notice },
      results: stopped,
      cancelled: notice,
      runList: [next, oldRun],
    })
    expect(html).not.toContain(t('results.running_sql', { sql: 'SELECT SLEEP(30)' }))
    expect(html).not.toContain('role="status"')
    expect(html).toContain(t('results.cancelled'))
  })

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
