import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { sql } from '@codemirror/lang-sql'
import { highlightingFor, syntaxTree } from '@codemirror/language'
import { tags } from '@lezer/highlight'
import { sqlLightHighlightStyle, sqlLightHighlighting } from '../editor-highlight'

const DOC = "SELECT id, 'abc', 42 -- note\nFROM users"
const withStyle = () => EditorState.create({ doc: DOC, extensions: [sql(), sqlLightHighlighting] })

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
    for (const cls of [keyword, comment, string, number]) expect(cls).toBeTruthy()
    expect(new Set([keyword, comment, string, number]).size).toBe(4)
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
})
