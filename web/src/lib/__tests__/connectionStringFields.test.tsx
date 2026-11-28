import { describe, it, expect, afterEach } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import ConnectionStringFields from '../../components/ConnectionStringFields'
import { t, setLocale } from '../translations'
import type { ConnectionTestState } from '../connection-string'

afterEach(() => setLocale('en'))

const noop = () => {}

function render(props: Partial<Parameters<typeof ConnectionStringFields>[0]>) {
  return renderToStaticMarkup(
    <ConnectionStringFields
      kind="postgres"
      url=""
      platformToken=""
      appToken=""
      testState={'idle' as ConnectionTestState}
      testError=""
      testInfo=""
      onUrlChange={noop}
      onPlatformTokenChange={noop}
      onAppTokenChange={noop}
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

  it('shows the MySQL copy — including "TiDB Cloud Starter only" — for a mysql target', () => {
    const html = render({ kind: 'mysql', url: 'mysql://u:p@host/db' })
    // The placeholder is rendered into an attribute, so its angle brackets arrive escaped
    const placeholder = t('admin_db.connection_url_placeholder_mysql').replace('<', '&lt;').replace('>', '&gt;')
    expect(html).toContain(placeholder)
    expect(html).toContain(t('admin_db.connection_url_hint_mysql'))
    expect(html).not.toContain(t('admin_db.connection_url_hint'))
    expect(t('admin_db.connection_url_hint_mysql')).toContain('TiDB Cloud Starter')
    expect(t('admin_db.connection_url_hint_mysql')).toMatch(/MySQL/)
  })

  it('asks a Spark target for its publish address and the two tokens', () => {
    const html = render({ kind: 'spark', url: 'https://spark.example.com' })
    // The address is not a secret; both tokens are, each with its own reveal toggle
    expect(html).toContain('id="db-connection-url" type="text"')
    expect(html).toContain('id="db-platform-token" type="password"')
    expect(html).toContain('id="db-app-token" type="password"')
    expect(html).toContain(t('admin_db.spark_url'))
    expect(html).toContain(t('admin_db.spark_platform_token'))
    expect(html).toContain(t('admin_db.spark_app_token'))
    expect(html).toContain(t('admin_db.spark_url_hint'))
    expect(html).toContain(t('admin_db.spark_token_hint'))
    // Spark UI fields
    expect(html).toContain('id="db-spark-ui-url" type="text"')
    expect(html).toContain('id="db-spark-ui-platform-token" type="password"')
    expect(html).toContain(t('admin_db.spark_ui_url'))
    expect(html).toContain(t('admin_db.spark_ui_platform_token'))
    // No SQL connection-string copy leaks into the Spark form
    expect(html).not.toContain(t('admin_db.connection_url_hint'))
    expect(html).not.toContain('type="password" data-reveal')
  })

  it('does not render Spark UI fields for non-Spark targets', () => {
    const pgHtml = render({ kind: 'postgres', url: 'postgresql://u:p@host/db' })
    expect(pgHtml).not.toContain('id="db-spark-ui-url"')
    expect(pgHtml).not.toContain('id="db-spark-ui-platform-token"')

    const mysqlHtml = render({ kind: 'mysql', url: 'mysql://u:p@host/db' })
    expect(mysqlHtml).not.toContain('id="db-spark-ui-url"')
    expect(mysqlHtml).not.toContain('id="db-spark-ui-platform-token"')
  })

  it('masks the Spark UI publish address in edit mode and offers a reveal toggle', () => {
    const html = render({ kind: 'spark', editing: true })
    expect(html).toContain('id="db-spark-ui-url" type="password"')
    expect(html).toContain('id="db-spark-ui-platform-token" type="password"')
  })

  it('shows pair validation alert only when exactly one Spark UI field is filled', () => {
    // Both empty: no alert
    expect(render({ kind: 'spark' })).not.toContain(t('admin_db.spark_ui_pair_hint'))

    // Both filled: no alert
    expect(
      render({
        kind: 'spark',
        uiUrl: 'https://spark-ui.example.com',
        uiPlatformToken: 'ui-token',
      })
    ).not.toContain(t('admin_db.spark_ui_pair_hint'))

    // Only uiUrl: alert
    const onlyUrlHtml = render({ kind: 'spark', uiUrl: 'https://spark-ui.example.com', uiPlatformToken: '' })
    expect(onlyUrlHtml).toContain('role="alert"')
    expect(onlyUrlHtml).toContain(t('admin_db.spark_ui_pair_hint'))

    // Only uiPlatformToken: alert
    const onlyTokenHtml = render({ kind: 'spark', uiUrl: '', uiPlatformToken: 'ui-token' })
    expect(onlyTokenHtml).toContain('role="alert"')
    expect(onlyTokenHtml).toContain(t('admin_db.spark_ui_pair_hint'))
  })

  it('disables the test button until something is typed', () => {
    expect(render({ url: '' })).toContain('disabled')
    expect(render({ url: '   ' })).toContain('disabled')
    expect(render({ url: 'postgresql://u:p@host/db' })).not.toContain('disabled')
  })

  it('needs all three Spark values before it can test', () => {
    const address = 'https://spark.example.com'
    expect(render({ kind: 'spark', url: address })).toContain('disabled')
    expect(render({ kind: 'spark', url: address, platformToken: 'p' })).toContain('disabled')
    expect(render({ kind: 'spark', url: address, platformToken: 'p', appToken: '  ' })).toContain('disabled')
    expect(render({ kind: 'spark', url: address, platformToken: 'p', appToken: 'a' })).not.toContain('disabled')
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

  it('has the Spark copy in Chinese too', () => {
    setLocale('zh')
    const html = render({ kind: 'spark', url: 'https://spark.example.com' })
    expect(html).toContain('发布地址')
    expect(html).toContain('平台令牌')
    expect(html).toContain('应用令牌')
    expect(html).toContain('Spark UI 发布地址')
    expect(html).toContain('Spark UI 平台令牌')
    expect(html).toContain(t('admin_db.show_secret'))
  })
})
