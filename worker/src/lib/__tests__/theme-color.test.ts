import { describe, expect, it } from 'vitest'
import { THEME_COLORS, isMissingThemeColorColumn, isThemeColor } from '../theme-color'

// The preset ids are frozen in the endpoint contract, and the web module paints exactly these
// (web/src/lib/theme-color.ts). Pinning the list here makes a drift a failing test, not a PUT that
// silently starts answering 400 for a preset the picker offers.
describe('THEME_COLORS', () => {
  it('is the six contracted presets, in the picker’s order', () => {
    expect(THEME_COLORS).toEqual(['terracotta', 'ocean', 'teal', 'forest', 'grape', 'rose'])
  })

  it('accepts only those ids, exactly as written', () => {
    for (const id of THEME_COLORS) expect(isThemeColor(id)).toBe(true)
    for (const other of ['blue', 'Ocean', '', ' terracotta', null, undefined, 42, {}]) {
      expect(isThemeColor(other)).toBe(false)
    }
  })
})

// The upgrade window hangs on this classification: a database without schema_v6 must answer 503
// ("run the upgrade"), while any other failure keeps its own path. The messages below are the real
// SQLite texts (a missing column in an expression gives `no such column: …`; in an INSERT column
// list it gives `table … has no column named …`), wrapped the way D1 reports them.
describe('isMissingThemeColorColumn', () => {
  const d1 = (sqliteMessage: string) => new Error(`D1_ERROR: ${sqliteMessage}: SQLITE_ERROR`)

  it.each([
    ['no such column: theme_color', 'a SELECT or SET target naming the missing column'],
    ['table users has no column named theme_color', 'an unprefixed INSERT column list'],
    ['table ZETA_users has no column named theme_color', 'a prefixed INSERT column list'],
  ])('classifies "%s" — %s', (message) => {
    expect(isMissingThemeColorColumn(d1(message))).toBe(true)
    // Also without D1's wrapper, and whatever the runtime wraps it in
    expect(isMissingThemeColorColumn(new Error(message))).toBe(true)
    expect(isMissingThemeColorColumn(message)).toBe(true)
  })

  it('ignores the message’s case', () => {
    expect(isMissingThemeColorColumn(d1('No Such Column: theme_color'))).toBe(true)
  })

  it.each([
    ['no such column: provider', 'another column of the same table'],
    ['no such table: users', 'a missing table, which is not this upgrade'],
    ['no such column: theme_color_backup', 'a column whose name only starts the same'],
    ['has no column named theme_color_old', 'the same, in the INSERT wording'],
    ['connection refused', 'a database that cannot be reached'],
    ['Network connection lost.', 'a transport failure'],
    ['near "SET": syntax error', 'a malformed statement'],
  ])('does not classify "%s" — %s', (message) => {
    expect(isMissingThemeColorColumn(d1(message))).toBe(false)
    expect(isMissingThemeColorColumn(new Error(message))).toBe(false)
  })
})
