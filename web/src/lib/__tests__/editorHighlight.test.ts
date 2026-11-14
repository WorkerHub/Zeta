import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { sql } from '@codemirror/lang-sql'
import { highlightingFor, syntaxTree } from '@codemirror/language'
import { tags } from '@lezer/highlight'
import { sqlFunctionCallRanges, sqlLightHighlightStyle, sqlLightHighlighting } from '../editor-highlight'

const DOC = "SELECT id, 'abc', 42 -- note\nFROM users"
const withStyle = () => EditorState.create({ doc: DOC, extensions: [sql(), sqlLightHighlighting] })

// Every token class must be visible at 13px on the editor's white background: the code tokens are
// checked against WCAG AA for normal text (4.5:1) right here, against the values in index.css.
function contrastOnWhite(hex: string): number {
  const channel = (offset: number) => {
    const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  }
  const luminance = 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5)
  return 1.05 / (luminance + 0.05)
}

describe('SQL editor light highlight', () => {
  // The light-mode bug: @codemirror/lang-sql parsed with one copy of @codemirror/language while
  // the highlighter came from another, so syntaxTree() was empty and nothing was ever painted.
  it('reads the parse tree of the SQL language (same @codemirror/language instance)', () => {
    const state = EditorState.create({ doc: DOC, extensions: [sql()] })
    expect(syntaxTree(state).length).toBe(DOC.length)
  })

  it('styles the main token categories, each with its own class', () => {
    const state = withStyle()
    const keyword = highlightingFor(state, [tags.keyword])
    const comment = highlightingFor(state, [tags.comment])
    const string = highlightingFor(state, [tags.string])
    const number = highlightingFor(state, [tags.number])
    const type = highlightingFor(state, [tags.typeName])
    for (const cls of [keyword, comment, string, number, type]) expect(cls).toBeTruthy()
    expect(new Set([keyword, comment, string, number, type]).size).toBe(5)
  })

  it('stays out of dark mode so oneDark is untouched', () => {
    const state = EditorState.create({
      doc: DOC,
      extensions: [sql(), sqlLightHighlighting, EditorView.theme({}, { dark: true })],
    })
    expect(highlightingFor(state, [tags.keyword])).toBeNull()
    expect(highlightingFor(state, [tags.comment])).toBeNull()
  })

  it('uses only existing design tokens, never a literal colour', () => {
    const css = readFileSync(new URL('../../index.css', import.meta.url), 'utf8')
    const values = sqlLightHighlightStyle.specs.flatMap((spec) =>
      Object.entries(spec)
        .filter(([key]) => key !== 'tag' && key !== 'class')
        .map(([, value]) => String(value))
    )
    expect(values.length).toBeGreaterThan(0)
    for (const value of values) {
      const match = /^var\((--color-[a-z0-9-]+)\)$/.exec(value)
      expect(match, `not a token reference: ${value}`).not.toBeNull()
      expect(css).toContain(`${match?.[1]}:`)
    }
  })

  // The five token classes are what the palette promises: saturated hues, each legible on white.
  it('keeps every code token at WCAG AA on the white editor background', () => {
    const css = readFileSync(new URL('../../index.css', import.meta.url), 'utf8')
    const tokens = ['keyword', 'function', 'string', 'number', 'type']
    for (const token of tokens) {
      const match = new RegExp(`--color-code-${token}: (#[0-9a-f]{6})`).exec(css)
      expect(match, `missing --color-code-${token}`).not.toBeNull()
      expect(contrastOnWhite(match?.[1] ?? ''), `--color-code-${token}`).toBeGreaterThanOrEqual(4.5)
    }
  })

  // Function-call names: lang-sql tags them as plain identifiers, so the plugin finds them by the
  // '(' that follows; without this class, `explode` would stay body-coloured.
  it('marks the names of function calls, and only those', () => {
    const doc = 'SELECT explode(x), posexplode(y) FROM t'
    const state = EditorState.create({ doc, extensions: [sql()] })
    const ranges = sqlFunctionCallRanges(state)
    expect(ranges.map((range) => doc.slice(range.from, range.to))).toEqual(['explode', 'posexplode'])
  })

  it('marks only the last segment of a qualified call', () => {
    const doc = 'SELECT a.b(c) FROM t'
    const state = EditorState.create({ doc, extensions: [sql()] })
    const ranges = sqlFunctionCallRanges(state)
    expect(ranges.map((range) => doc.slice(range.from, range.to))).toEqual(['b'])
  })

  it('does not mistake table names before a column list for calls', () => {
    for (const doc of ["INSERT INTO users (name) VALUES ('a')", 'CREATE TABLE t (a INT)']) {
      const state = EditorState.create({ doc, extensions: [sql()] })
      expect(sqlFunctionCallRanges(state), doc).toEqual([])
    }
  })

  // The decoration carries no colour of its own: its only rule is the light-scoped one, which both
  // keeps oneDark untouched and proves the class paints through a token rather than a literal.
  it('colours the function-call class from a token, in light mode only', () => {
    const css = readFileSync(new URL('../../index.css', import.meta.url), 'utf8')
    expect(css).toMatch(
      /:root:not\(\.dark\) \.cm-editor \.cm-sql-fn-call\s*\{\s*color: var\(--color-code-function\);\s*\}/
    )
    expect(css.match(/\.cm-sql-fn-call/g)).toHaveLength(1)
  })
})
