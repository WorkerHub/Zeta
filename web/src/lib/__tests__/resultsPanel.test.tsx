import { afterEach, describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import ResultsPanel from '../../components/ResultsPanel'
import type { StatementResult } from '../../types'
import { setLocale } from '../translations'

afterEach(() => setLocale('en'))

const noop = () => {}

const statement = (sql: string): StatementResult => ({ sql, results: [{ n: 1 }], duration_ms: 3 })

function render(results: StatementResult[], activeIndex = 0) {
  return renderToStaticMarkup(<ResultsPanel results={results} activeIndex={activeIndex} onSelectIndex={noop} />)
}

// The panel shows a run as it reads: the statement first, not the comments above it
describe('ResultsPanel SQL source header', () => {
  it('starts at the statement instead of the comment lines above it', () => {
    const html = render([statement('-- 注释\nshow tables')])
    expect(html).toContain('>show tables<')
    expect(html).not.toContain('-- 注释')
  })

  it('strips the header of whichever statement is selected', () => {
    const html = render([statement('SELECT 1'), statement('/* 第二条 */\nSELECT 2')], 1)
    expect(html).toContain('>SELECT 2<')
    expect(html).not.toContain('/* 第二条 */')
  })

  it('keeps a comment that belongs to the statement itself', () => {
    const html = render([statement('SELECT 1 -- 只取一行')])
    expect(html).toContain('SELECT 1 -- 只取一行')
  })

  it('falls back to the stored text when the statement is nothing but comments', () => {
    const html = render([statement('-- 只有注释')])
    expect(html).toContain('-- 只有注释')
  })
})

describe('ResultsPanel Spark state errors (§7.6)', () => {
  const failed = (error: string, extra: Partial<StatementResult> = {}): StatementResult => ({
    sql: 'SELECT 1',
    results: [],
    duration_ms: 3,
    error,
    ...extra,
  })

  it('renders a draining/restarting environment amber, never red', () => {
    const html = render([failed('the worker sentence', { code: 'context_draining', inflight: 2 })])
    expect(html).toContain('text-warning-600')
    expect(html).not.toContain('text-danger-600')
  })

  it('renders a rejected profile key red, with the key named', () => {
    const html = render([failed('x', { code: 'startup_key_in_profile', key: 'spark.sql.extensions' })])
    expect(html).toContain('text-danger-600')
    expect(html).toContain('spark.sql.extensions')
  })

  it('renders a plain SQL error red and keeps the worker message', () => {
    const html = render([failed('Unknown table "nope"')])
    expect(html).toContain('text-danger-600')
    expect(html).toContain('Unknown table &quot;nope&quot;')
  })
})

describe('ResultsPanel statement list', () => {
  it('previews every statement from its own first line, without the comments above it', () => {
    const html = render([statement('-- 用户量\nSELECT 1'), statement('# 订单量\nSELECT 2')], 0)
    expect(html).toContain('>SELECT 1</div>')
    expect(html).toContain('>SELECT 2</div>')
    expect(html).not.toContain('-- 用户量')
    expect(html).not.toContain('# 订单量')
  })

  it('leaves a statement without leading comments as it is', () => {
    const html = render([statement('SELECT 1'), statement('SELECT 2')], 0)
    expect(html).toContain('>SELECT 1</div>')
    expect(html).toContain('>SELECT 2</div>')
  })
})
