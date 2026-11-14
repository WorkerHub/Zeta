// Light-mode syntax highlighting for the SQL editor (pages/Query.tsx).
//
// Colours are design tokens only (§2 of docs/design-system.md): every value is a
// `var(--color-*)` reference into `@theme`, never a literal colour. The token layer keeps the
// light/dark pair in one place, and the brand ramp stays reserved for CTAs, links and focus
// rings (§2.1) — the editor uses the neutral and functional ramps as hues.
//
// `themeType: 'light'` makes this style inert whenever the editor runs a dark theme, so oneDark
// keeps dark mode exactly as it was and the page needs no conditional extension.
//
// IMPORTANT: this style must come from the same `@codemirror/language` instance that parses the
// document. The language's parse tree lives in a `StateField` owned by that copy, so a highlighter
// from another copy sees an empty tree and silently paints nothing (that was the light-mode bug:
// @codemirror/lang-sql pulled 6.12.3 while @uiw's basicSetup pulled 6.12.4). web/package.json pins
// `@codemirror/language` to 6.12.3 for this reason, and `@lezer/highlight` to 1.2.3 because tag
// identity is what tag matching compares. __tests__/editorHighlight.test.ts fails loudly if the
// graph ever splits again.
import { HighlightStyle, syntaxHighlighting, type TagStyle } from '@codemirror/language'
import { tags } from '@lezer/highlight'

// Contrast on the editor's white background (#fff, the light theme of @uiw/react-codemirror):
// body text (identifiers, punctuation) stays --color-ink-950 at 17.63:1, so comments at 4.82:1 read
// as clearly weaker while still passing 4.5:1 at 13px.
export const sqlLightHighlightSpecs: readonly TagStyle[] = [
  // Comments: grey and recessed. ink-500, not ink-400 (2.77:1) — §2.2 keeps ink-400 for
  // non-body text, and 13px code has to stay readable.
  { tag: tags.comment, color: 'var(--color-ink-500)' }, // 4.82:1
  // Keywords: the one hue the eye lands on first.
  { tag: tags.keyword, color: 'var(--color-info-700)' }, // 9.12:1
  // Types, plus the `standard(name)` slot for dialects that mark builtins (lang-sql maps its
  // `Builtin` token there; the standard dialect used by the editor emits none, so in practice this
  // rule carries type keywords like INT). One step lighter than keywords so it reads as a related
  // but distinct family.
  { tag: [tags.typeName, tags.standard(tags.name)], color: 'var(--color-info-600)' }, // 6.73:1
  { tag: [tags.string, tags.special(tags.string), tags.character], color: 'var(--color-success-700)' }, // 7.73:1
  { tag: [tags.number, tags.bool, tags.null, tags.atom], color: 'var(--color-warning-700)' }, // 7.41:1
  // Operators recede slightly from the body without disappearing.
  { tag: [tags.operator, tags.operatorKeyword], color: 'var(--color-ink-700)' }, // 9.83:1
]

export const sqlLightHighlightStyle = HighlightStyle.define(sqlLightHighlightSpecs, { themeType: 'light' })

export const sqlLightHighlighting = syntaxHighlighting(sqlLightHighlightStyle)
