// Light-mode syntax highlighting for the SQL editor (pages/Query.tsx).
//
// Colours are design tokens only (§2 of docs/design-system.md): every value is a
// `var(--color-*)` reference into `@theme`, never a literal colour. The five token classes read
// `--color-code-*`, a saturated set the editor carries for itself (§2.3's functional ramps read
// grey at 13px); the brand ramp stays reserved for CTAs, links and focus rings (§2.1). Comments
// keep the neutral ramp.
//
// `themeType: 'light'` makes this style inert whenever the editor runs a dark theme, so oneDark
// keeps dark mode exactly as it was and the page needs no conditional extension.
//
// Function-call names are the one class tags cannot carry here: lang-sql's standard dialect parses
// `explode(x)` as a plain `Identifier` (tags.name — `cast`, `count` etc. are `Keyword` instead),
// and it never emits `tags.function(...)`, so a HighlightStyle rule for the function tag would
// paint nothing. `sqlLightFunctionCalls` therefore marks the identifier in front of '(' with a
// `cm-sql-fn-call` decoration, and the light-mode rule in index.css gives that class its colour.
//
// IMPORTANT: this style must come from the same `@codemirror/language` instance that parses the
// document. The language's parse tree lives in a `StateField` owned by that copy, so a highlighter
// from another copy sees an empty tree and silently paints nothing (that was the light-mode bug:
// @codemirror/lang-sql pulled 6.12.3 while @uiw's basicSetup pulled 6.12.4). web/package.json pins
// `@codemirror/language` to 6.12.3 for this reason, and `@lezer/highlight` to 1.2.3 because tag
// identity is what tag matching compares. __tests__/editorHighlight.test.ts fails loudly if the
// graph ever splits again. `@codemirror/view` (the plugin and decorations below) resolves to a
// single copy across the graph, so it needs no pin.
import type { EditorState, Extension } from '@codemirror/state'
import { HighlightStyle, syntaxHighlighting, syntaxTree, type TagStyle } from '@codemirror/language'
import { Decoration, type DecorationSet, type EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view'
import { tags } from '@lezer/highlight'

// Contrast on the editor's white background (#fff, the light theme of @uiw/react-codemirror):
// body text (identifiers, punctuation) stays --color-ink-950 at 17.63:1, so comments at 4.82:1 read
// as clearly weaker while still passing 4.5:1 at 13px.
export const sqlLightHighlightSpecs: readonly TagStyle[] = [
  // Comments: grey and recessed. ink-500, not ink-400 (2.77:1) — §2.2 keeps ink-400 for
  // non-body text, and 13px code has to stay readable.
  { tag: tags.comment, color: 'var(--color-ink-500)' }, // 4.82:1
  // Keywords: the one hue the eye lands on first.
  { tag: tags.keyword, color: 'var(--color-code-keyword)' }, // 5.70:1
  // Types, plus the `standard(name)` slot for dialects that mark builtins (lang-sql maps its
  // `Builtin` token there; the standard dialect used by the editor emits none, so in practice this
  // rule carries type keywords like INT). Teal, so the type family stays apart from the blue of
  // function calls — the two hues sit closest to each other (see the palette note in index.css).
  { tag: [tags.typeName, tags.standard(tags.name)], color: 'var(--color-code-type)' }, // 5.36:1
  { tag: [tags.string, tags.special(tags.string), tags.character], color: 'var(--color-code-string)' }, // 5.48:1
  { tag: [tags.number, tags.bool, tags.null, tags.atom], color: 'var(--color-code-number)' }, // 5.18:1
  // Operators recede slightly from the body without disappearing.
  { tag: [tags.operator, tags.operatorKeyword], color: 'var(--color-ink-700)' }, // 9.83:1
]

export const sqlLightHighlightStyle = HighlightStyle.define(sqlLightHighlightSpecs, { themeType: 'light' })

export const sqlLightHighlighting = syntaxHighlighting(sqlLightHighlightStyle)

// Clause keywords after which an identifier followed by '(' names a table and its column list
// rather than a call: INSERT INTO t (…), CREATE TABLE t (…), CREATE INDEX … ON t (…). Without
// this, every INSERT and DDL statement would paint its table name like a function.
const NON_CALL_PRECEDERS = new Set(['INTO', 'TABLE', 'ON'])

// Ranges of the function-call names in `state`: identifier leaves whose next non-whitespace
// character is '('. Exported and pure so the guard tests can read the ranges without a DOM.
export function sqlFunctionCallRanges(state: EditorState): { from: number; to: number }[] {
  const doc = state.doc
  const ranges: { from: number; to: number }[] = []
  syntaxTree(state).iterate({
    enter(node) {
      if (node.name !== 'Identifier') return
      const prev = node.node.prevSibling
      if (prev && NON_CALL_PRECEDERS.has(doc.sliceString(prev.from, prev.to).toUpperCase())) return
      let pos = node.to
      while (pos < doc.length && /\s/.test(doc.sliceString(pos, pos + 1))) pos++
      if (doc.sliceString(pos, pos + 1) === '(') ranges.push({ from: node.from, to: node.to })
    },
  })
  return ranges
}

const sqlFunctionCallMark = Decoration.mark({ class: 'cm-sql-fn-call' })

function buildFunctionCallDecorations(state: EditorState): DecorationSet {
  return Decoration.set(
    sqlFunctionCallRanges(state).map((range) => sqlFunctionCallMark.range(range.from, range.to)),
    true
  )
}

// Marks function-call names for the light-mode rule in index.css (`:root:not(.dark)` scoped, so a
// dark editor keeps oneDark's colours untouched — the decoration carries no colour of its own).
// Rebuilt when the document changes, the viewport moves, or the parser hands out a new tree.
export const sqlLightFunctionCalls: Extension = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet
    constructor(view: EditorView) {
      this.decorations = buildFunctionCallDecorations(view.state)
    }
    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged || syntaxTree(update.startState) !== syntaxTree(update.state)) {
        this.decorations = buildFunctionCallDecorations(update.state)
      }
    }
  },
  { decorations: (plugin) => plugin.decorations }
)
