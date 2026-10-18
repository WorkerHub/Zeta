import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Database, Globe, Loader2 } from 'lucide-react'
import { setupApi, SetupApiError } from '../lib/api'
import { resolveSetupView, setupErrorInfo, type SetupView } from '../lib/setup'
import { useLocale } from '../hooks/useLocale'

export default function Setup() {
  const { t, locale, changeLocale } = useLocale()
  const [view, setView] = useState<SetupView | 'loading'>('loading')
  // Set when GET /api/setup/state failed: the page stays usable but warns the user.
  const [stateHint, setStateHint] = useState(false)
  const [secret, setSecret] = useState('')
  const [error, setError] = useState('')
  const [upgraded, setUpgraded] = useState<string[] | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    let cancelled = false
    setupApi
      .state()
      .then((s) => {
        if (cancelled) return
        setView(resolveSetupView(s.enabled))
      })
      .catch(() => {
        if (cancelled) return
        // A failed state request is treated as "available" rather than blanking the page.
        setView(resolveSetupView(null))
        setStateHint(true)
      })
    return () => {
      cancelled = true
    }
  }, [])

  async function handleSubmit() {
    setError('')
    setUpgraded(null)
    if (!secret.trim()) {
      setError(t('setup.error_missing_secret'))
      inputRef.current?.focus()
      return
    }
    setSubmitting(true)
    try {
      const res = await setupApi.run(secret)
      setUpgraded(res.upgraded ?? [])
    } catch (err) {
      if (err instanceof SetupApiError) {
        const info = setupErrorInfo(err.status, err.message, err.retryAfter)
        setError(t(info.key, info.vars))
      } else {
        setError(t('errors.generic'))
      }
      inputRef.current?.focus()
    } finally {
      // Never keep the secret in the field (or anywhere else) after the request.
      setSecret('')
      setSubmitting(false)
    }
  }

  const success = upgraded !== null
  const upgradedItems = upgraded && upgraded.length > 0 ? upgraded : null

  return (
    <div className="relative min-h-screen flex items-center justify-center p-4 bg-zinc-50 dark:bg-zinc-950">
      <button
        type="button"
        onClick={() => changeLocale(locale === 'en' ? 'zh' : 'en')}
        className="absolute top-4 right-4 btn-ghost p-2"
        title={t('lang.label')}
      >
        <Globe size={16} />
      </button>
      <div className="w-full max-w-sm">
        <div className="flex items-center justify-center gap-2 mb-8">
          <div className="w-9 h-9 bg-blue-600 rounded-lg flex items-center justify-center">
            <Database size={20} className="text-white" />
          </div>
          <span className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">{t('app.name')}</span>
        </div>

        {view === 'loading' ? (
          <div className="card p-6 text-sm text-zinc-500">{t('common.loading')}</div>
        ) : view === 'disabled' ? (
          <div className="card p-6 space-y-4">
            <h1 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">{t('setup.title')}</h1>
            <p role="alert" className="text-sm text-zinc-600 dark:text-zinc-300">
              {t('setup.disabled')}
            </p>
            <Link to="/login" className="btn-primary w-full">
              {t('setup.go_login')}
            </Link>
          </div>
        ) : (
          <div className="card p-6">
            <h1 className="text-lg font-semibold text-zinc-900 mb-1 dark:text-zinc-100">{t('setup.title')}</h1>
            <p className="text-sm text-zinc-500 mb-6">{t('setup.desc')}</p>

            {success ? (
              <div role="status" className="space-y-4">
                {upgradedItems ? (
                  <>
                    <p className="text-sm text-emerald-500">{t('setup.upgraded_title')}</p>
                    <ul className="text-sm text-zinc-700 dark:text-zinc-300 list-disc list-inside space-y-1">
                      {upgradedItems.map((item) => (
                        <li key={item}>{item}</li>
                      ))}
                    </ul>
                    <Link to="/login" className="btn-primary w-full">
                      {t('setup.go_login')}
                    </Link>
                  </>
                ) : (
                  <>
                    <p className="text-sm text-emerald-500">{t('setup.success')}</p>
                    <Link to="/register" className="btn-primary w-full">
                      {t('setup.register_admin')}
                    </Link>
                    <Link to="/login" className="btn-secondary w-full">
                      {t('setup.go_login')}
                    </Link>
                  </>
                )}
              </div>
            ) : (
              <form onSubmit={(e) => e.preventDefault()} className="space-y-4">
                {stateHint && <p className="text-xs text-amber-500">{t('setup.state_unavailable')}</p>}
                <div>
                  <label htmlFor="setup-secret" className="label">
                    {t('setup.secret_label')}
                  </label>
                  <input
                    id="setup-secret"
                    ref={inputRef}
                    type="password"
                    value={secret}
                    onChange={(e) => setSecret(e.target.value)}
                    className="input"
                    autoComplete="off"
                    required
                    // biome-ignore lint/a11y/noAutofocus: single-purpose setup form; its only field is the entry point
                    autoFocus
                  />
                </div>

                {error && (
                  <p role="alert" className="text-sm text-red-400">
                    {error}
                  </p>
                )}

                <button type="button" onClick={handleSubmit} className="btn-primary w-full" disabled={submitting}>
                  {submitting ? <Loader2 size={14} className="animate-spin" /> : null}
                  {submitting ? t('setup.submitting') : t('setup.submit')}
                </button>
              </form>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
