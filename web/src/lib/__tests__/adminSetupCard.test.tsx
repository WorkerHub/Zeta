import { describe, it, expect, afterEach } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { AdminSetupCard } from '../../pages/admin/AdminSettings'
import { t, setLocale } from '../translations'

afterEach(() => setLocale('en'))

const noop = () => {}

function render(props: Partial<Parameters<typeof AdminSetupCard>[0]>) {
  return renderToStaticMarkup(<AdminSetupCard t={t} upgraded={null} error="" running={false} onRun={noop} {...props} />)
}

describe('AdminSetupCard', () => {
  it('renders the up-to-date message when nothing was upgraded', () => {
    const html = render({ upgraded: [] })
    expect(html).toContain(t('admin_setup.up_to_date'))
    expect(html).not.toContain(t('admin_setup.upgraded_title'))
  })

  it('lists upgrade items as text (never as HTML)', () => {
    const html = render({ upgraded: ['users: added notebook_run_limit', '<img src=x>'] })
    expect(html).toContain(t('admin_setup.upgraded_title'))
    expect(html).toContain('users: added notebook_run_limit')
    expect(html).toContain('&lt;img src=x&gt;')
    expect(html).not.toContain('<img src=x>')
  })

  it('renders an error with role="alert"', () => {
    const html = render({ error: 'DDL error: something broke' })
    expect(html).toContain('role="alert"')
    expect(html).toContain('DDL error: something broke')
  })

  it('disables the button and shows the running label while running', () => {
    const html = render({ running: true })
    expect(html).toContain('disabled')
    expect(html).toContain(t('admin_setup.running'))
    expect(html).not.toContain(t('admin_setup.run'))
  })
})
