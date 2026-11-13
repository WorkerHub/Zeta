import { useState } from 'react'
import { Eye, EyeOff, Loader2, PlugZap } from 'lucide-react'
import { useLocale } from '../hooks/useLocale'
import type { PgTestState } from '../lib/pg-connection'

interface Props {
  url: string
  testState: PgTestState
  /** Error text of a failed test, shown verbatim (the worker's message never includes the secret). */
  testError: string
  /** Detail of the last passing test, e.g. "PostgreSQL 18.6 · 320 ms". */
  testInfo: string
  onUrlChange: (url: string) => void
  onTest: () => void
}

/**
 * Connection-string block of the registration form: a masked field with a reveal toggle, the
 * test-connection button and its outcome. Pure presentation — the page owns the state machine.
 */
export default function PostgresConnectionFields({ url, testState, testError, testInfo, onUrlChange, onTest }: Props) {
  const { t } = useLocale()
  const [revealed, setRevealed] = useState(false)
  const testing = testState === 'testing'

  return (
    <div className="sm:col-span-2 space-y-2">
      <label htmlFor="db-connection-url" className="label">
        {t('admin_db.connection_url')}
      </label>
      <div className="relative">
        <input
          id="db-connection-url"
          type={revealed ? 'text' : 'password'}
          className="input pr-11 font-mono text-caption"
          value={url}
          onChange={(e) => onUrlChange(e.target.value)}
          placeholder={t('admin_db.connection_url_placeholder')}
          autoComplete="off"
          spellCheck={false}
          aria-describedby="db-connection-url-hint"
        />
        <button
          type="button"
          onClick={() => setRevealed((v) => !v)}
          className="btn-ghost absolute right-1 top-1/2 -translate-y-1/2 p-1.5"
          aria-label={revealed ? t('admin_db.hide_connection_url') : t('admin_db.show_connection_url')}
          title={revealed ? t('admin_db.hide_connection_url') : t('admin_db.show_connection_url')}
        >
          {revealed ? <EyeOff size={14} aria-hidden="true" /> : <Eye size={14} aria-hidden="true" />}
        </button>
      </div>
      <p id="db-connection-url-hint" className="text-caption text-ink-500">
        {t('admin_db.connection_url_hint')}
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={onTest}
          disabled={testing || url.trim() === ''}
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
