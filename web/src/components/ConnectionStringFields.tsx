import { useState } from 'react'
import { Eye, EyeOff, Loader2, PlugZap } from 'lucide-react'
import { useLocale } from '../hooks/useLocale'
import type { ConnectionKind, ConnectionTestState } from '../lib/connection-string'

interface Props {
  /** Which engine the values are for: it selects the fields and their copy. */
  kind: ConnectionKind
  /** Connection string (PostgreSQL/MySQL) or the SparkSQL service's publish address. */
  url: string
  /** Spark only: the publish address' platform token. */
  platformToken: string
  /** Spark only: the service's app token. */
  appToken: string
  testState: ConnectionTestState
  /** Error text of a failed test, shown verbatim unless it carries a translatable code. */
  testError: string
  /** Detail of the last passing test, e.g. "PostgreSQL 18.6 · 320 ms". */
  testInfo: string
  onUrlChange: (url: string) => void
  onPlatformTokenChange: (token: string) => void
  onAppTokenChange: (token: string) => void
  onTest: () => void
}

type Field = 'url' | 'platform' | 'app'

function RevealToggle({ revealed, label, onToggle }: { revealed: boolean; label: string; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="btn-ghost absolute right-1 top-1/2 -translate-y-1/2 p-1.5"
      aria-label={label}
      title={label}
    >
      {revealed ? <EyeOff size={14} aria-hidden="true" /> : <Eye size={14} aria-hidden="true" />}
    </button>
  )
}

/**
 * The values block of the registration form: a masked field per pasted secret, the test-connection
 * button and its outcome. Pure presentation — the page owns the state machine, and the engine only
 * decides which fields and which copy are shown (MySQL means TiDB Cloud Starter; SparkSQL is one
 * service addressed by a publish URL plus two tokens).
 */
export default function ConnectionStringFields({
  kind,
  url,
  platformToken,
  appToken,
  testState,
  testError,
  testInfo,
  onUrlChange,
  onPlatformTokenChange,
  onAppTokenChange,
  onTest,
}: Props) {
  const { t } = useLocale()
  const [revealed, setRevealed] = useState<Record<Field, boolean>>({ url: false, platform: false, app: false })
  const toggle = (field: Field) => setRevealed((current) => ({ ...current, [field]: !current[field] }))
  const testing = testState === 'testing'
  const spark = kind === 'spark'
  const mysql = kind === 'mysql'

  // Spark cannot be tested until all three values are there; a connection string alone speaks for
  // the other two engines.
  const incomplete = spark
    ? url.trim() === '' || platformToken.trim() === '' || appToken.trim() === ''
    : url.trim() === ''

  const urlCopy = spark
    ? { label: 'admin_db.spark_url', placeholder: 'admin_db.spark_url_placeholder', hint: 'admin_db.spark_url_hint' }
    : mysql
      ? {
          label: 'admin_db.connection_url',
          placeholder: 'admin_db.connection_url_placeholder_mysql',
          hint: 'admin_db.connection_url_hint_mysql',
        }
      : {
          label: 'admin_db.connection_url',
          placeholder: 'admin_db.connection_url_placeholder',
          hint: 'admin_db.connection_url_hint',
        }

  const tokens: Array<{ field: Field; id: string; label: string; value: string; onChange: (v: string) => void }> = [
    {
      field: 'platform',
      id: 'db-platform-token',
      label: 'admin_db.spark_platform_token',
      value: platformToken,
      onChange: onPlatformTokenChange,
    },
    {
      field: 'app',
      id: 'db-app-token',
      label: 'admin_db.spark_app_token',
      value: appToken,
      onChange: onAppTokenChange,
    },
  ]

  return (
    <div className="sm:col-span-2 space-y-2">
      <label htmlFor="db-connection-url" className="label">
        {t(urlCopy.label)}
      </label>
      <div className="relative">
        <input
          id="db-connection-url"
          type={spark || revealed.url ? 'text' : 'password'}
          className="input pr-11 font-mono text-caption"
          value={url}
          onChange={(e) => onUrlChange(e.target.value)}
          placeholder={t(urlCopy.placeholder)}
          autoComplete="off"
          spellCheck={false}
          aria-describedby="db-connection-url-hint"
        />
        {!spark && (
          <RevealToggle
            revealed={revealed.url}
            label={revealed.url ? t('admin_db.hide_connection_url') : t('admin_db.show_connection_url')}
            onToggle={() => toggle('url')}
          />
        )}
      </div>
      <p id="db-connection-url-hint" className="text-caption text-ink-500">
        {t(urlCopy.hint)}
      </p>

      {spark && (
        <>
          {tokens.map((token) => (
            <div key={token.field} className="space-y-2 pt-1">
              <label htmlFor={token.id} className="label">
                {t(token.label)}
              </label>
              <div className="relative">
                <input
                  id={token.id}
                  type={revealed[token.field] ? 'text' : 'password'}
                  className="input pr-11 font-mono text-caption"
                  value={token.value}
                  onChange={(e) => token.onChange(e.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                />
                <RevealToggle
                  revealed={revealed[token.field]}
                  label={revealed[token.field] ? t('admin_db.hide_secret') : t('admin_db.show_secret')}
                  onToggle={() => toggle(token.field)}
                />
              </div>
            </div>
          ))}
          <p className="text-caption text-ink-500">{t('admin_db.spark_token_hint')}</p>
        </>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={onTest}
          disabled={testing || incomplete}
          className="btn-secondary btn-sm gap-1.5"
        >
          {testing ? (
            <Loader2 size={13} className="animate-spin" aria-hidden="true" />
          ) : (
            <PlugZap size={13} aria-hidden="true" />
          )}
          {testing ? t('admin_db.testing_connection') : t('admin_db.test_connection')}
        </button>
        {testState === 'passed' && (
          <span role="status" className="text-body text-success-600">
            {t('admin_db.test_passed')}
            {testInfo && <span className="text-ink-500"> · {testInfo}</span>}
          </span>
        )}
        {testState === 'failed' && (
          <span role="alert" className="text-body text-danger-600 break-words">
            {testError || t('admin_db.test_failed')}
          </span>
        )}
      </div>
    </div>
  )
}
