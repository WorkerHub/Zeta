import { describe, it, expect, afterEach } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import PostgresConnectionFields from '../../components/PostgresConnectionFields'
import { t, setLocale } from '../translations'
import type { PgTestState } from '../pg-connection'

afterEach(() => setLocale('en'))

const noop = () => {}

function render(props: Partial<Parameters<typeof PostgresConnectionFields>[0]>) {
  return renderToStaticMarkup(
    <PostgresConnectionFields
      url=""
      testState={'idle' as PgTestState}
      testError=""
      testInfo=""
      onUrlChange={noop}
      onTest={noop}
      {...props}
    />
  )
}

describe('PostgresConnectionFields', () => {
  it('masks the string by default and offers a reveal toggle', () => {
    const html = render({ url: 'postgresql://u:p@host/db' })
    expect(html).toContain('type="password"')
    expect(html).not.toContain('type="text"')
    expect(html).toContain(t('admin_db.show_connection_url'))
    expect(html).toContain(t('admin_db.connection_url_hint'))
  })

  it('disables the test button until something is typed', () => {
    expect(render({ url: '' })).toContain('disabled')
    expect(render({ url: '   ' })).toContain('disabled')
    expect(render({ url: 'postgresql://u:p@host/db' })).not.toContain('disabled')
  })

  it('shows a spinner and a busy label while testing', () => {
    const html = render({ url: 'postgresql://u:p@host/db', testState: 'testing' })
    expect(html).toContain(t('admin_db.testing_connection'))
    expect(html).toContain('animate-spin')
    expect(html).toContain('disabled')
  })

  it('announces a passing test with its detail', () => {
    const html = render({ url: 'postgresql://u:p@host/db', testState: 'passed', testInfo: 'PostgreSQL 18.6 · 320 ms' })
    expect(html).toContain('role="status"')
    expect(html).toContain(t('admin_db.test_passed'))
    expect(html).toContain('PostgreSQL 18.6 · 320 ms')
    expect(html).not.toContain('role="alert"')
  })

  it('renders a failed test as an escaped alert', () => {
    const html = render({
      url: 'postgresql://u:wrong@host/db',
      testState: 'failed',
      testError: 'password authentication failed <script>alert(1)</script>',
    })
    expect(html).toContain('role="alert"')
    expect(html).toContain('password authentication failed')
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
    expect(html).not.toContain('role="status"')
  })

  it('falls back to a generic failure line when the error text is empty', () => {
    expect(render({ url: 'postgresql://u:p@host/db', testState: 'failed' })).toContain(t('admin_db.test_failed'))
  })
})
