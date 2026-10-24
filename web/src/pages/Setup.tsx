import { useEffect, useRef, useState, type RefObject } from 'react'
import { Link } from 'react-router-dom'
import { Globe, Loader2 } from 'lucide-react'
import { setupApi, SetupApiError } from '../lib/api'
import { resolveSetupView, setupErrorInfo, type SetupView } from '../lib/setup'
import { useLocale } from '../hooks/useLocale'
import Logo from '../components/Logo'

type Translate = (key: string, vars?: Record<string, string | number>) => string

// Stateless presentation for the card, split out of the page so its three branches (form /
// disabled / success) can be asserted without a browser via renderToStaticMarkup.
interface SetupCardProps {
  t: Translate
  view: SetupView | 'loading'
  stateHint: boolean
  secret: string
  error: string
  // null = not submitted yet (show the form); otherwise a success, empty for a fresh database
  // or a list of upgrade items.
  upgradedItems: string[] | null
  submitting: boolean
  inputRef: RefObject<HTMLInputElement | null>
  onSecretChange: (value: string) => void
  onSubmit: () => void
}

export function SetupCard({
  t,
  view,
  stateHint,
  secret,
  error,
  upgradedItems,
  submitting,
  inputRef,
  onSecretChange,
  onSubmit,
}: SetupCardProps) {
  if (view === 'loading') {
    return <div className="card p-6 text-body text-ink-500">{t('common.loading')}</div>
  }

  if (view === 'disabled') {
    return (
      <div className="card p-6 space-y-4">
        <h1 className="text-heading text-ink-900">{t('setup.title')}</h1>
        <p role="alert" className="text-body text-ink-700">
          {t('setup.disabled')}
        </p>
        <Link to="/login" className="btn-primary w-full">
          {t('setup.go_login')}
        </Link>
      </div>
    )
  }

  const success = upgradedItems !== null

  return (
    <div className="card p-6">
      <h1 className="text-heading text-ink-900 mb-1">{t('setup.title')}</h1>
      <p className="text-body text-ink-500 mb-6">{t('setup.desc')}</p>

      {success ? (
        <div role="status" className="space-y-4">
          {upgradedItems && upgradedItems.length > 0 ? (
            <>
              <p className="text-body text-success-600">{t('setup.upgraded_title')}</p>
              <ul className="text-body text-ink-700 list-disc list-inside space-y-1">
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
              <p className="text-body text-success-600">{t('setup.success')}</p>
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
        <form
          onSubmit={(e) => {
            e.preventDefault()
            onSubmit()
          }}
          className="space-y-4"
        >
          {stateHint && <p className="text-caption text-warning-600">{t('setup.state_unavailable')}</p>}
          <div>
            <label htmlFor="setup-secret" className="label">
              {t('setup.secret_label')}
            </label>
            <input
              id="setup-secret"
              ref={inputRef}
              type="password"
              value={secret}
              onChange={(e) => onSecretChange(e.target.value)}
              className="input"
              autoComplete="off"
              required
              // biome-ignore lint/a11y/noAutofocus: single-purpose setup form; its only field is the entry point
              autoFocus
            />
          </div>

          {error && (
            <p role="alert" className="text-body text-danger-600">
              {error}
            </p>
          )}

          <button type="button" onClick={onSubmit} className="btn-primary w-full" disabled={submitting}>
            {submitting ? <Loader2 size={14} className="animate-spin" /> : null}
            {submitting ? t('setup.submitting') : t('setup.submit')}
          </button>
        </form>
      )}
    </div>
  )
}

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

  return (
    <div className="relative min-h-screen flex items-center justify-center p-4 bg-ink-50">
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
          <Logo size="md" />
          <span className="text-title text-ink-900">{t('app.name')}</span>
        </div>

        <SetupCard
          t={t}
          view={view}
          stateHint={stateHint}
          secret={secret}
          error={error}
          upgradedItems={upgraded}
          submitting={submitting}
          inputRef={inputRef}
          onSecretChange={setSecret}
          onSubmit={() => void handleSubmit()}
        />
      </div>
    </div>
  )
}
