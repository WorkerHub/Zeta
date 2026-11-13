import { describe, it, expect, afterEach } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import ThemeColorCard from '../../components/ThemeColorCard'
import { setLocale, t } from '../translations'

afterEach(() => setLocale('en'))

const render = (syncError: string | null = null) =>
  renderToStaticMarkup(<ThemeColorCard value="ocean" onChange={() => {}} syncError={syncError} />)

describe('ThemeColorCard', () => {
  it('uses the account wording, with no browser-only caveat', () => {
    const html = render()
    expect(html).toContain(t('profile.theme_color'))
    expect(html).toContain(t('profile.theme_color_desc'))
    expect(html).not.toContain('browser only')
    expect(html).not.toContain('本浏览器')
  })

  it('shows no error while the last save succeeded', () => {
    expect(render(null)).not.toContain('role="alert"')
  })

  it('surfaces the generic rollback error with role="alert"', () => {
    const html = render(t('errors.theme_color_save_failed'))
    expect(html).toContain('role="alert"')
    expect(html).toContain(t('errors.theme_color_save_failed'))
  })

  it('renders a server upgrade hint verbatim (503 pass-through)', () => {
    const html = render('Please run the database upgrade in Admin → Settings first.')
    expect(html).toContain('role="alert"')
    expect(html).toContain('Please run the database upgrade in Admin → Settings first.')
    expect(html).not.toContain(t('errors.theme_color_save_failed'))
  })

  it('carries the Chinese copy too', () => {
    setLocale('zh')
    expect(t('profile.theme_color_desc')).toContain('账号')
    const html = render(t('errors.theme_color_save_failed'))
    expect(html).toContain('role="alert"')
    expect(html).toContain(t('errors.theme_color_save_failed'))
  })
})
