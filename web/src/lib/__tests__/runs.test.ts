import { describe, it, expect } from 'vitest'
import { addRun, cacheResults, clearRunsState, emptyRunsState, receivePage, removeRun } from '../runs'
import type { NotebookRunSummary } from '../../types'

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
