import { readFileSync } from 'node:fs'
import { describe, it, expect, afterEach } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import RunHistoryBar from '../../components/RunHistoryBar'
import { t, setLocale } from '../translations'
import type { NotebookRunSummary } from '../../types'

afterEach(() => setLocale('en'))

// The strip's hairline scrollbar and the separators between tabs live in the global stylesheet as
// scoped selectors (`.run-history-scroll`, `.run-tab-strip`, `.run-tab-accent`), which are the
// contract this test pins: geometry, tokens, transparent track in every state.
const stylesheet = readFileSync(new URL('../../index.css', import.meta.url), 'utf8')

// Every declaration block written for exactly this selector (a selector can carry more than one
// rule — the element itself, and again inside the @supports block)
function allDeclarations(selector: string): string[] {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return [...stylesheet.matchAll(new RegExp(`(?:^|\\n)\\s*${escaped}\\s*\\{([^}]*)\\}`, 'g'))].map((m) => m[1] ?? '')
}

function declarations(selector: string): string {
  return allDeclarations(selector)[0] ?? ''
}

const noop = () => {}

const run = (id: string, seq: number): NotebookRunSummary => ({
  id,
  seq,
  notebook_id: 'nb-1',
  database_id: 'db-1',
  database_name: 'analytics',
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

const runs = [run('run-3', 3), run('run-2', 2), run('run-1', 1)]

function render(props: { running?: boolean; selected?: NotebookRunSummary | null } = {}) {
  return renderToStaticMarkup(
    <RunHistoryBar
      runs={runs}
      selected={props.selected === undefined ? runs[0]! : props.selected}
      running={props.running ?? false}
      runningDatabaseName={props.running ? 'analytics' : ''}
      hasMore={false}
      loading={false}
      loadError={false}
      onSelect={noop}
      onLoadMore={noop}
      onDelete={noop}
      onCancelRun={noop}
    />
  )
}

// The tab wrappers as rendered: each carries its own class list
const wrappers = (html: string) => html.match(/<div class="[^"]*rounded-md border[^"]*"/g) ?? []

describe('RunHistoryBar strip styling hooks', () => {
  it('marks the scrolling strip so the hairline scrollbar reaches it alone', () => {
    const html = render()
    expect(html).toContain('run-history-scroll')
    // The standard property would make Chrome drop the ::-webkit- rules the hairline needs
    expect(html).not.toContain('scrollbar-width')
  })

  it('marks the tablist for the separators between adjacent tabs', () => {
    expect(render()).toContain('run-tab-strip')
  })

  it('marks the highlighted tab so no separator stacks against its own border', () => {
    const html = render()
    expect(wrappers(html).filter((w) => w.includes('run-tab-accent'))).toHaveLength(1)
    expect(wrappers(html)[0]).toContain('run-tab-accent')
  })

  it('marks the run in flight the same way, and only that one', () => {
    const html = render({ running: true })
    expect(
      wrappers(html)
        .slice(0, 2)
        .every((w) => w.includes('run-tab-accent'))
    ).toBe(true)
    expect(
      wrappers(html)
        .slice(2)
        .some((w) => w.includes('run-tab-accent'))
    ).toBe(false)
  })

  it('marks nothing but the saved runs when the notebook has no selection', () => {
    const html = render({ selected: null })
    expect(wrappers(html).some((w) => w.includes('run-tab-accent'))).toBe(false)
  })
})

describe('RunHistoryBar hairline scrollbar', () => {
  it('reserves an 8px gutter so thickening on hover never reflows the strip', () => {
    expect(declarations('.run-history-scroll::-webkit-scrollbar')).toMatch(/height:\s*8px/)
  })

  it('reads as a 4px line at rest, through a transparent border clipped out of the thumb', () => {
    const thumb = declarations('.run-history-scroll::-webkit-scrollbar-thumb')
    expect(declarations('.run-history-scroll')).toMatch(/--run-strip-thumb-inset:\s*2px/)
    expect(thumb).toMatch(/border:\s*var\(--run-strip-thumb-inset\) solid transparent/)
    expect(thumb).toMatch(/background-clip:\s*padding-box/)
    expect(thumb).toMatch(/border-radius:\s*9999px/)
    // Ink-300 at rest, in the frozen token layer rather than a bare colour
    expect(thumb).toMatch(/background-color:\s*var\(--color-ink-300\)/)
  })

  it('fills the whole gutter on hover, through an inset the hovered strip itself declares', () => {
    // Chrome paints a custom scrollbar from the bar's own hover state: a rule that only touches the
    // ::-webkit- thumb of a hovered element never repaints it (measured — hovering a tab kept the
    // 4px line). Flipping an inherited custom property in the element's own :hover is what makes
    // the engine repaint, so that declaration is part of the contract, not decoration.
    expect(declarations('.run-history-scroll:hover')).toMatch(/--run-strip-thumb-inset:\s*0px/)
    expect(declarations('.run-history-scroll:hover::-webkit-scrollbar-thumb')).toMatch(/var\(--color-ink-400\)/)
  })

  it('keeps the full 8px gutter while the thumb is dragged, without a track behind it', () => {
    const active = declarations('.run-history-scroll::-webkit-scrollbar-thumb:active')
    expect(active).toMatch(/border-width:\s*0/)
    expect(active).toMatch(/var\(--color-ink-400\)/)
  })

  it.each([
    '.run-history-scroll::-webkit-scrollbar-track',
    '.run-history-scroll::-webkit-scrollbar-track:hover',
    '.run-history-scroll::-webkit-scrollbar-track:active',
    '.run-history-scroll::-webkit-scrollbar-corner',
  ])('keeps the track transparent in %s', (selector) => {
    expect(declarations(selector)).toMatch(/background:\s*transparent/)
  })

  it('gives Firefox the standard properties instead, guarded so Chrome keeps the pseudo-elements', () => {
    expect(stylesheet).toContain('@supports not selector(::-webkit-scrollbar)')
    expect(allDeclarations('.run-history-scroll').join('\n')).toMatch(/scrollbar-width:\s*thin/)
    expect(allDeclarations('.run-history-scroll').join('\n')).toMatch(
      /scrollbar-color:\s*var\(--color-ink-300\)\s+transparent/
    )
    expect(allDeclarations('.run-history-scroll:hover').join('\n')).toMatch(
      /scrollbar-color:\s*var\(--color-ink-400\)\s+transparent/
    )
  })
})

describe('RunHistoryBar separators', () => {
  it('draws a 1px, 14px line in ink-200 between adjacent tabs only', () => {
    expect(declarations('.run-tab-strip > * + *')).toMatch(/position:\s*relative/)
    const line = declarations('.run-tab-strip > * + *::before')
    expect(line).toMatch(/width:\s*1px/)
    expect(line).toMatch(/height:\s*14px/)
    expect(line).toMatch(/background-color:\s*var\(--color-ink-200\)/)
    // Centred on the tab boxes, and never in the way of a click
    expect(line).toMatch(/top:\s*calc\(50% - 7px\)/)
    expect(line).toMatch(/pointer-events:\s*none/)
  })

  it('adds no line before the first tab or after the last one', () => {
    // `* + *` skips the first box; nothing is drawn after a box, so the strip ends without one
    expect(stylesheet).not.toContain('.run-tab-strip::after')
    expect(stylesheet).not.toContain('.run-tab-strip > *::before')
  })

  it('drops the line on both sides of a highlighted tab', () => {
    expect(declarations('.run-tab-strip > .run-tab-accent::before')).toMatch(/content:\s*none/)
    expect(declarations('.run-tab-strip > .run-tab-accent + *::before')).toMatch(/content:\s*none/)
  })
})

describe('RunHistoryBar keeps its tab semantics', () => {
  it('still renders one tab per run with the selected one focusable', () => {
    const html = render()
    expect(html.match(/role="tab"/g)).toHaveLength(3)
    expect(html).toContain(t('runs.tablist'))
    expect(html.match(/aria-selected="true"/g)).toHaveLength(1)
    expect(html.match(/tabindex="0"/gi)).toHaveLength(1)
  })
})
