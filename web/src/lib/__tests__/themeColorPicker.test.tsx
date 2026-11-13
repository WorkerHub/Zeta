import { describe, it, expect, afterEach } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import ThemeColorPicker from '../../components/ThemeColorPicker'
import { useThemeColor } from '../../hooks/useThemeColor'
import { THEME_COLORS, type ThemeColor } from '../theme-color'
import { setLocale, t } from '../translations'

afterEach(() => setLocale('en'))

const render = (value: ThemeColor = 'ocean') =>
  renderToStaticMarkup(<ThemeColorPicker value={value} onChange={() => {}} />)

// The hook reads localStorage on its first render; a probe component proves the no-DOM fallback
// (the project has no jsdom, so the attribute side is covered by the browser run instead)
function Probe() {
  const { themeColor, setThemeColor } = useThemeColor()
  return <span>{`${themeColor}/${typeof setThemeColor}`}</span>
}

describe('ThemeColorPicker', () => {
  it('offers one radio per preset, drawn with that preset swatch token', () => {
    const html = render('ocean')
    expect([...html.matchAll(/name="theme-color"/g)]).toHaveLength(THEME_COLORS.length)
    for (const id of THEME_COLORS) expect(html).toContain(`bg-swatch-${id}`)
  })

  it('checks the active preset and rings it in the live brand colour', () => {
    const html = render('ocean')
    expect([...html.matchAll(/checked=""/g)]).toHaveLength(1)
    expect(html).toMatch(/aria-label="Ocean"[^>]*checked=""/)
    expect(html).toContain('peer-checked:ring-brand-600')
    expect(html).toContain('dark:peer-checked:ring-brand-400')
    expect(html).toContain('peer-focus-visible:outline-brand-600')
    // A single icon in the row: the check inside the active dot
    expect([...html.matchAll(/<svg/g)]).toHaveLength(1)
  })

  it('moves the check when another preset is active', () => {
    const html = render('terracotta')
    expect(html).toMatch(/aria-label="Terracotta"[^>]*checked=""/)
  })

  it('carries the Chinese preset names too', () => {
    setLocale('zh')
    expect(t('profile.theme_color')).toBe('主题色')
    const html = render('rose')
    expect(html).toMatch(/aria-label="玫瑰"[^>]*checked=""/)
    for (const name of ['陶土', '海蓝', '青碧', '森绿', '葡萄紫']) expect(html).toContain(`aria-label="${name}"`)
  })
})

describe('useThemeColor', () => {
  it('defaults to terracotta and exposes a setter without a DOM', () => {
    expect(renderToStaticMarkup(<Probe />)).toContain('terracotta/function')
  })
})
