import { describe, it, expect, afterEach } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import ThemeColorCard from '../../components/ThemeColorCard'
import { setLocale, t } from '../translations'

afterEach(() => setLocale('en'))

const render = (syncError = false) =>
  renderToStaticMarkup(<ThemeColorCard value="ocean" onChange={() => {}} syncError={syncError} />)

describe('ThemeColorCard', () => {
  it('uses the account wording, with no browser-only caveat', () => {
    const html = render()
    expect(html).toContain(t('profile.theme_color'))
    expect(html).toContain(t('profile.theme_color_desc'))
    expect(t('profile.theme_color_desc')).not.toContain('browser only')
    expect(t('profile.theme_color_desc')).not.toContain('本浏览器')
  })

  it('shows no error while the last save succeeded', () => {
    expect(render(false)).not.toContain('role="alert"')
  })

  it('surfaces the rollback error with role="alert"', () => {
    const html = render(true)
    expect(html).toContain('role="alert"')
    expect(html).toContain(t('errors.theme_color_save_failed'))
  })

  it('carries the Chinese copy too', () => {
    setLocale('zh')
    expect(t('profile.theme_color_desc')).toContain('账号')
    const html = render(true)
    expect(html).toContain('role="alert"')
    expect(html).toContain(t('errors.theme_color_save_failed'))
  })
})
