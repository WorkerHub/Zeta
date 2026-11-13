import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import {
  DEFAULT_THEME_COLOR,
  THEME_COLORS,
  THEME_COLOR_STORAGE_KEY,
  hasStoredThemeColor,
  isThemeColor,
  normalizeThemeColor,
  planThemeColorSync,
  readStoredThemeColor,
  rollbackThemeColor,
  themeSaveErrorMessage,
} from '../theme-color'

// The pre-paint script ships as a plain static file (it must run before the bundle), so its preset
// whitelist is a second copy of the ids — this test is what keeps the two from drifting apart.
const initScript = readFileSync(new URL('../../../public/theme-init.js', import.meta.url), 'utf8')

describe('theme colour presets', () => {
  it('lists the six presets in picker order, terracotta first as the default', () => {
    expect(THEME_COLORS).toEqual(['terracotta', 'ocean', 'teal', 'forest', 'grape', 'rose'])
    expect(THEME_COLORS[0]).toBe(DEFAULT_THEME_COLOR)
    expect(THEME_COLOR_STORAGE_KEY).toBe('theme-color')
  })

  it('keeps every known id and falls back to terracotta for anything else', () => {
    for (const id of THEME_COLORS) {
      expect(isThemeColor(id)).toBe(true)
      expect(normalizeThemeColor(id)).toBe(id)
    }
    for (const bad of [null, undefined, '', 'nope', ' ocean', 'terracotta ', 'Ocean']) {
      expect(isThemeColor(bad)).toBe(false)
      expect(normalizeThemeColor(bad)).toBe('terracotta')
    }
  })

  it('reads the default without a DOM or a stored value', () => {
    expect(readStoredThemeColor()).toBe('terracotta')
  })

  it('keeps the pre-paint script on the same preset list and storage key', () => {
    const match = initScript.match(/var themeColors = \[([^\]]*)\]/)
    expect(match).not.toBeNull()
    const ids = [...match![1]!.matchAll(/'([\w-]+)'/g)].map((m) => m[1])
    expect(ids).toEqual([...THEME_COLORS])
    expect(initScript).toContain(`localStorage.getItem('${THEME_COLOR_STORAGE_KEY}')`)
    expect(initScript).toContain("setAttribute('data-theme-color', c)")
  })
})

describe('server sync decision', () => {
  it('adopts a known server id, even the default, and never pushes', () => {
    expect(planThemeColorSync('ocean', true, 'grape')).toEqual({ color: 'ocean', push: false })
    expect(planThemeColorSync('terracotta', true, 'ocean')).toEqual({ color: 'terracotta', push: false })
  })

  it('keeps a stored local value and pushes it when the server has none', () => {
    expect(planThemeColorSync(null, true, 'grape')).toEqual({ color: 'grape', push: true })
  })

  it('treats an unknown server id as unset', () => {
    expect(planThemeColorSync('nope', true, 'grape')).toEqual({ color: 'grape', push: true })
    expect(planThemeColorSync('nope', false, 'grape')).toEqual({ color: 'terracotta', push: false })
  })

  it('falls back to the default without a push when nothing is stored', () => {
    expect(planThemeColorSync(null, false, 'grape')).toEqual({ color: 'terracotta', push: false })
  })

  it('reports no stored preset without a DOM', () => {
    expect(hasStoredThemeColor()).toBe(false)
  })
})

describe('save failure copy', () => {
  it('shows the server sentence verbatim for a 503 (database not upgraded)', () => {
    expect(themeSaveErrorMessage(503, 'Please run the database upgrade first.', 'fallback')).toBe(
      'Please run the database upgrade first.'
    )
  })

  it('falls back to the generic copy for any other failure', () => {
    expect(themeSaveErrorMessage(500, 'boom', 'fallback')).toBe('fallback')
    expect(themeSaveErrorMessage(400, 'bad id', 'fallback')).toBe('fallback')
    expect(themeSaveErrorMessage(undefined, undefined, 'fallback')).toBe('fallback')
  })

  it('does not show an empty 503 message', () => {
    expect(themeSaveErrorMessage(503, '', 'fallback')).toBe('fallback')
  })
})

describe('rollback target', () => {
  it('returns to the last server-confirmed colour once the boot answered', () => {
    expect(rollbackThemeColor('ocean', 'grape')).toBe('ocean')
  })

  it('returns to the pre-switch screen colour before the first boot answer', () => {
    expect(rollbackThemeColor(null, 'grape')).toBe('grape')
  })
})
