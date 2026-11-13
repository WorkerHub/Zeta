import { describe, it, expect, afterEach } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import ConnectionStringFields from '../../components/ConnectionStringFields'
import { t, setLocale, translations } from '../translations'
import { registerCopyKeys } from '../pg-connection'
import type { ConnectionStringKind, ConnectionTestState } from '../pg-connection'

afterEach(() => setLocale('en'))

const noop = () => {}

function render(props: Partial<Parameters<typeof ConnectionStringFields>[0]>) {
  return renderToStaticMarkup(
    <ConnectionStringFields
      kind={'postgres' as ConnectionStringKind}
      url=""
      testState={'idle' as ConnectionTestState}
      testError=""
      testInfo=""
      onUrlChange={noop}
      onTest={noop}
      {...props}
    />
  )
}

describe('ConnectionStringFields', () => {
  it('masks the string by default and offers a reveal toggle', () => {
    const html = render({ url: 'postgresql://u:p@host/db' })
    expect(html).toContain('type="password"')
    expect(html).not.toContain('type="text"')
    expect(html).toContain(t('admin_db.show_connection_url'))
    expect(html).toContain(t('admin_db.connection_url_hint'))
  })

  it('shows the PostgreSQL example for a postgres target', () => {
    const html = render({ kind: 'postgres' })
    expect(html).toContain(t('admin_db.connection_url_placeholder'))
    expect(html).not.toContain(t('admin_db.connection_url_placeholder_mysql'))
  })

  it('shows the TiDB Cloud example and the TiDB-only hint for a mysql target', () => {
    const html = render({ kind: 'mysql' })
    // React escapes the <region> part of the example, so compare against the escaped form
    const example = t('admin_db.connection_url_placeholder_mysql').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    expect(html).toContain(example)
    expect(html).toContain(t('admin_db.connection_url_hint_mysql'))
    expect(html).not.toContain('postgresql://')
    expect(html).toContain('tidbcloud.com')
    expect(html).toContain('TiDB Cloud Starter')
  })

  it('disables the test button until something is typed', () => {
    expect(render({ url: '' })).toContain('disabled')
    expect(render({ url: '   ' })).toContain('disabled')
    expect(render({ url: 'postgresql://u:p@host/db' })).not.toContain('disabled')
    expect(render({ kind: 'mysql', url: 'mysql://u:p@host:4000/db' })).not.toContain('disabled')
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

  it('shows the TiDB version a MySQL target reports', () => {
    const html = render({
      kind: 'mysql',
      url: 'mysql://u:p@host:4000/db',
      testState: 'passed',
      testInfo: '8.0.11-TiDB-v8.5.3 · 120 ms',
    })
    expect(html).toContain(t('admin_db.test_passed'))
    expect(html).toContain('8.0.11-TiDB-v8.5.3 · 120 ms')
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

describe('registration copy per engine', () => {
  it('points every engine at keys that exist', () => {
    for (const kind of ['sqlite', 'postgres', 'mysql', 'spark'] as const) {
      const keys = registerCopyKeys(kind)
      expect(translations.en[keys.title], keys.title).toBeTypeOf('string')
      expect(translations.en[keys.desc], keys.desc).toBeTypeOf('string')
      expect(translations.zh[keys.title], keys.title).toBeTypeOf('string')
      expect(translations.zh[keys.desc], keys.desc).toBeTypeOf('string')
    }
  })

  it('gives MySQL its own registration copy', () => {
    expect(registerCopyKeys('mysql').title).not.toBe(registerCopyKeys('postgres').title)
    expect(registerCopyKeys('postgres').title).toBe('admin_db.register_title_pg')
  })

  it('says MySQL means TiDB Cloud Starter only, in both languages', () => {
    const { title, desc } = registerCopyKeys('mysql')
    const hint = 'admin_db.connection_url_hint_mysql'
    expect(translations.en[title]).toContain('TiDB Cloud Starter')
    expect(translations.en[desc]).toContain('TiDB Cloud Starter')
    expect(translations.en[desc]).toContain('MariaDB')
    expect(translations.zh[title]).toContain('TiDB Cloud Starter')
    expect(translations.zh[desc]).toContain('仅支持 TiDB Cloud Starter')
    expect(translations.zh[desc]).toContain('MariaDB')

    expect(translations.en[hint]).toContain('Only TiDB Cloud Starter')
    expect(translations.en[hint]).toContain('MariaDB')
    expect(translations.zh[hint]).toContain('仅支持 TiDB Cloud Starter')
    expect(translations.zh[hint]).toContain('MariaDB')
  })

  it('gives the MySQL field a TiDB Cloud example string', () => {
    for (const locale of ['en', 'zh'] as const) {
      const placeholder = translations[locale]['admin_db.connection_url_placeholder_mysql']!
      expect(placeholder.startsWith('mysql://')).toBe(true)
      expect(placeholder).toContain('tidbcloud.com:4000/')
    }
  })
})
