import { describe, it, expect, afterEach } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import type { RefObject } from 'react'
import { SetupCard } from '../../pages/Setup'
import { t, setLocale } from '../translations'

afterEach(() => setLocale('en'))

const noop = () => {}
const inputRef: RefObject<HTMLInputElement | null> = { current: null }

function render(props: Partial<Parameters<typeof SetupCard>[0]>) {
  return renderToStaticMarkup(
    <MemoryRouter>
      <SetupCard
        t={t}
        view="form"
        stateHint={false}
        secret=""
        error=""
        upgradedItems={null}
        submitting={false}
        inputRef={inputRef}
        onSecretChange={noop}
        onSubmit={noop}
        {...props}
      />
    </MemoryRouter>
  )
}

describe('SetupCard', () => {
  it('renders the password form when the page is enabled', () => {
    const html = render({ view: 'form' })
    expect(html).toContain('type="password"')
    expect(html).not.toContain(t('setup.disabled'))
  })

  it('renders the disabled notice without the form when disabled', () => {
    const html = render({ view: 'disabled' })
    expect(html).toContain(t('setup.disabled'))
    expect(html).not.toContain('type="password"')
  })

  it('renders an error with role="alert"', () => {
    const html = render({ view: 'form', error: 'Incorrect setup secret.' })
    expect(html).toContain('role="alert"')
    expect(html).toContain('Incorrect setup secret.')
  })

  it('renders the fresh-database links on a clean success', () => {
    const html = render({ view: 'form', upgradedItems: [] })
    expect(html).toContain(t('setup.success'))
    expect(html).toContain('href="/register"')
    expect(html).toContain('href="/login"')
  })

  it('lists upgrade items as text (never as HTML)', () => {
    const html = render({ view: 'form', upgradedItems: ['users: added notebook_run_limit', '<img src=x>'] })
    expect(html).toContain(t('setup.upgraded_title'))
    expect(html).toContain('users: added notebook_run_limit')
    expect(html).toContain('&lt;img src=x&gt;')
    expect(html).not.toContain('<img src=x>')
  })
})
