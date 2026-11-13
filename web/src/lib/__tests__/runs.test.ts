import { describe, it, expect } from 'vitest'
import {
  addRun,
  cacheResults,
  cancelNotice,
  clearRunsState,
  emptyRunsState,
  haltNotice,
  idlePending,
  receivePage,
  removeRun,
  runCancelNotice,
  runHaltNotice,
  runningPending,
  settleRun,
  withCancelling,
} from '../runs'
import type { NotebookRunSummary, StatementResult } from '../../types'

// `at` doubles as the run number
const run = (id: string, at: number, notebook_id = 'nb-1'): NotebookRunSummary => ({
  id,
  seq: at,
  notebook_id,
  database_id: 'db-1',
  database_name: 'one',
  sql: 'SELECT 1',
  statement_count: 1,
  row_count: 1,
  error_count: 0,
  duration_ms: 1,
  storage_truncated: 0,
  results_bytes: 10,
  executed_at: at,
  accessible: true,
})
const ids = (list: NotebookRunSummary[]) => list.map((r) => r.id)

describe('receivePage', () => {
  it('loads the first page and selects the newest run', () => {
    const s = receivePage({ ...emptyRunsState, loading: true }, [run('b', 2), run('a', 1)], true, false)
    expect(ids(s.list)).toEqual(['b', 'a'])
    expect(s).toMatchObject({ selectedRunId: 'b', hasMore: true, loaded: true, loading: false })
  })

  it('appends later pages without duplicates and keeps the selection', () => {
    let s = receivePage(emptyRunsState, [run('c', 3), run('b', 2)], true, false)
    s = { ...s, selectedRunId: 'b' }
    s = receivePage(s, [run('b', 2), run('a', 1)], false, true)
    expect(ids(s.list)).toEqual(['c', 'b', 'a'])
    expect(s.selectedRunId).toBe('b')
    expect(s.hasMore).toBe(false)
  })

  it('keeps a run made here that the server has not stored yet', () => {
    const s = receivePage(addRun(emptyRunsState, run('new', 5)), [run('old', 1)], false, false)
    expect(ids(s.list)).toEqual(['new', 'old'])
    expect(s.selectedRunId).toBe('new')
  })

  it('drops a run made here that is older than the reloaded list (deleted or pruned meanwhile)', () => {
    const s = receivePage(addRun(emptyRunsState, run('gone', 2)), [run('newer', 3)], false, false)
    expect(ids(s.list)).toEqual(['newer'])
    expect(s.selectedRunId).toBe('newer')
  })
})

describe('run list updates', () => {
  it('puts a new run first and selects it', () => {
    const s = addRun(receivePage(emptyRunsState, [run('a', 1)], false, false), run('b', 2))
    expect(ids(s.list)).toEqual(['b', 'a'])
    expect(s.selectedRunId).toBe('b')
  })

  it('keeps the list ordered by number when runs finish out of order', () => {
    let s = receivePage(emptyRunsState, [run('a', 1)], false, false)
    s = addRun(s, run('c', 3))
    s = addRun(s, run('b', 2))
    expect(ids(s.list)).toEqual(['c', 'b', 'a'])
    expect(s.selectedRunId).toBe('b')
  })

  it('selects the next older run when the selected one is removed', () => {
    const base = receivePage(emptyRunsState, [run('c', 3), run('b', 2), run('a', 1)], false, false)
    expect(removeRun({ ...base, selectedRunId: 'b' }, 'b').selectedRunId).toBe('a')
    expect(removeRun({ ...base, selectedRunId: 'a' }, 'a').selectedRunId).toBe('b')
    expect(removeRun({ ...base, selectedRunId: 'c' }, 'a').selectedRunId).toBe('c')
    expect(removeRun(receivePage(emptyRunsState, [run('a', 1)], false, false), 'a').selectedRunId).toBeNull()
  })

  it('clears a notebook', () => {
    const s = clearRunsState({
      ...receivePage(emptyRunsState, [run('a', 1)], true, false),
      loading: true,
      loadError: true,
    })
    expect(s).toMatchObject({
      list: [],
      hasMore: false,
      selectedRunId: null,
      loaded: true,
      loading: false,
      loadError: false,
    })
  })
})

describe('cacheResults', () => {
  it('evicts the least recently used entries beyond the limit', () => {
    let cache = new Map<string, number>()
    for (const key of ['a', 'b', 'c']) cache = cacheResults(cache, key, 1, 3)
    cache = cacheResults(cache, 'a', 2, 3) // touch a
    cache = cacheResults(cache, 'd', 1, 3)
    expect([...cache.keys()]).toEqual(['c', 'a', 'd'])
    expect(cache.get('a')).toBe(2)
  })
})

describe('the run in flight', () => {
  it('turns a settled run into the selected saved one', () => {
    const settled = settleRun(runningPending('one', 'SELECT 1', 1), {
      run: run('new', 4),
      results: [{ sql: 'SELECT 1', results: [], duration_ms: 1 }],
    })
    expect(settled).toMatchObject({ accepted: true, pending: idlePending })
    if (!settled.accepted) throw new Error('expected the outcome to be accepted')
    const s = addRun(receivePage(emptyRunsState, [run('old', 3)], false, false), settled.run!)
    expect(ids(s.list)).toEqual(['new', 'old'])
    expect(s.selectedRunId).toBe('new')
  })

  it('keeps results the server did not name as transient', () => {
    const results = [{ sql: 'SELECT 1', results: [{ a: 1 }], duration_ms: 2 }]
    expect(settleRun(runningPending('one', 'SELECT 1', 1), { run: null, results })).toMatchObject({
      accepted: true,
      pending: { running: false, error: '', transient: results },
    })
  })

  it('keeps a reported error', () => {
    expect(settleRun(runningPending('one', 'SELECT 1', 1), { error: 'boom' })).toMatchObject({
      accepted: true,
      pending: { running: false, error: 'boom', transient: null },
    })
  })

  it('carries the submitted SQL and its statement count, and clears both when the run ends', () => {
    const pending = runningPending('one', 'SELECT 1', 3)
    expect(pending).toMatchObject({ running: true, sql: 'SELECT 1', statementCount: 3 })
    expect(settleRun(pending, { error: 'boom' })).toMatchObject({
      pending: { sql: '', statementCount: 0 },
    })
  })

  // 正在取消… belongs to the run in flight, so it goes away with it
  it('marks the run in flight as cancelling, and can take it back', () => {
    const pending = runningPending('one', 'SELECT 1', 1)
    const cancelling = withCancelling(pending, true)
    expect(cancelling).toMatchObject({ running: true, cancelling: true })
    expect(withCancelling(cancelling, false)).toMatchObject({ running: true, cancelling: false })
    // Writing the flag it already has changes nothing
    expect(withCancelling(cancelling, true)).toBe(cancelling)
  })

  it('does not mark a run that is not in flight', () => {
    expect(withCancelling(idlePending, true)).toBe(idlePending)
    expect(withCancelling({ ...idlePending, error: 'boom' }, true)).toEqual({ ...idlePending, error: 'boom' })
  })

  it('lands a cancelled execution as its own outcome, with the notice its engine earns', () => {
    const notice = cancelNotice('sqlite')
    const settled = settleRun(withCancelling(runningPending('one', 'SELECT 1', 1), true), {
      run: run('cancelled', 9),
      results: [],
      cancelled: notice,
    })
    if (!settled.accepted) throw new Error('expected the outcome to be accepted')
    expect(settled.run?.id).toBe('cancelled')
    // The notice rides with the run that landed; the next one starts from a clean slate
    expect(settled.pending).toEqual(idlePending)
  })

  it('keeps the cancelled notice with results the server did not name', () => {
    const notice = cancelNotice('mysql')
    expect(
      settleRun(runningPending('one', 'SELECT SLEEP(30)', 1), { run: null, results: [], cancelled: notice })
    ).toMatchObject({
      accepted: true,
      pending: { running: false, transient: [], cancelled: notice },
    })
  })

  it('keeps the halted notice with results the server did not name', () => {
    const results: StatementResult[] = [{ sql: 'SELECT boom', results: [], duration_ms: 0, error: 'no such column' }]
    const halted = haltNotice(true, results, 3)
    expect(halted).toEqual({ failedAt: 1, remaining: 2 })
    expect(settleRun(runningPending('one', 'SELECT boom', 3), { run: null, results, halted })).toMatchObject({
      accepted: true,
      pending: { running: false, transient: results, halted },
    })
  })

  it('leaves no notice behind when the next run ends', () => {
    const results: StatementResult[] = [{ sql: 'SELECT boom', results: [], duration_ms: 0, error: 'nope' }]
    const halted = haltNotice(true, results, 2)
    const transient = settleRun(runningPending('one', 'SELECT boom', 2), { run: null, results, halted })
    if (!transient.accepted) throw new Error('expected the outcome to be accepted')
    // The next run starts from a clean slate and its successor settles without one
    expect(runningPending('one', 'SELECT 1', 1).halted).toBeNull()
    expect(settleRun(runningPending('one', 'SELECT 1', 1), { run: run('next', 2), results: [] })).toMatchObject({
      pending: idlePending,
    })
  })
})

describe('haltNotice', () => {
  const errorAt = (n: number): StatementResult[] =>
    Array.from({ length: n }, (_, i) =>
      i === n - 1
        ? { sql: 'SELECT boom', results: [], duration_ms: 0, error: 'no such column: boom' }
        : { sql: 'SELECT 1', results: [{ n: 1 }], duration_ms: 1 }
    )

  it('names the failing statement and what never ran', () => {
    // Three submitted, two attempted, the second one failed
    expect(haltNotice(true, errorAt(2), 3)).toEqual({ failedAt: 2, remaining: 1 })
    expect(haltNotice(true, errorAt(1), 3)).toEqual({ failedAt: 1, remaining: 2 })
  })

  it('says nothing for a run that completed', () => {
    expect(haltNotice(false, errorAt(3), 3)).toBeNull()
    expect(haltNotice(undefined, errorAt(3), 3)).toBeNull()
  })

  it('says nothing when every submitted statement was attempted or nothing came back', () => {
    expect(haltNotice(true, errorAt(3), 3)).toBeNull()
    expect(haltNotice(true, [], 3)).toBeNull()
    // A count that cannot be trusted never invents a number
    expect(haltNotice(true, errorAt(2), 1)).toBeNull()
  })

  it('takes the last failing entry, and falls back to the returned count', () => {
    const twoErrors: StatementResult[] = [
      { sql: 'SELECT boom', results: [], duration_ms: 0, error: 'first' },
      { sql: 'SELECT 1', results: [], duration_ms: 1 },
      { sql: 'SELECT boom', results: [], duration_ms: 0, error: 'last' },
    ]
    expect(haltNotice(true, twoErrors, 5)).toEqual({ failedAt: 3, remaining: 2 })
    const noErrorEntry: StatementResult[] = [{ sql: 'SELECT 1', results: [], duration_ms: 1 }]
    expect(haltNotice(true, noErrorEntry, 2)).toEqual({ failedAt: 1, remaining: 1 })
  })

  it("reads a saved run's own record, so history shows the same notice", () => {
    const ran: NotebookRunSummary = { ...run('saved', 4), statement_count: 3 }
    expect(runHaltNotice({ ...ran, halted: true }, errorAt(2))).toEqual({ failedAt: 2, remaining: 1 })
    expect(runHaltNotice({ ...ran, halted: false }, errorAt(3))).toBeNull()
    // A record written before the halt column existed has no flag: nothing is announced
    expect(runHaltNotice(ran, errorAt(2))).toBeNull()
  })
})

describe('cancelNotice', () => {
  it('adds the caveat only for the engines that cannot kill a statement', () => {
    // D1 has no cancellation channel and TiDB kills nothing: their statement finishes on the server
    expect(cancelNotice('sqlite')).toEqual({ caveat: true })
    expect(cancelNotice('mysql')).toEqual({ caveat: true })
    // PostgreSQL cancels by application_name and Spark by execution-level job group: really killed
    expect(cancelNotice('postgres')).toEqual({ caveat: false })
    expect(cancelNotice('spark')).toEqual({ caveat: false })
  })

  it("reads a saved run's own record, which carries no engine to claim a caveat for", () => {
    expect(runCancelNotice({ cancelled: true })).toEqual({ caveat: false })
    expect(runCancelNotice({ cancelled: false })).toBeNull()
    expect(runCancelNotice({})).toBeNull()
  })
})
