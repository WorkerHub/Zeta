import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Globe } from 'lucide-react'
import { authApi } from '../lib/api'
import { useLocale } from '../hooks/useLocale'
import Logo from '../components/Logo'

export default function ForgotPassword() {
  const { t, locale, changeLocale } = useLocale()
  const [email, setEmail] = useState('')
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError('')
    try {
      const res = await authApi.forgotPassword({ email })
      setMessage(res.message)
    } catch (err) {
      // Keep the form so the user can retry
      setError(err instanceof Error ? err.message : t('errors.generic'))
    } finally {
      setLoading(false)
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

        <div className="card p-6">
          <h1 className="text-heading text-ink-900 mb-2">{t('auth.forgot_title')}</h1>
          <p className="text-body text-ink-500 mb-6">{t('auth.forgot_desc')}</p>

          {message ? (
            <div className="space-y-4">
              <p className="text-body text-success-600" role="status">
                {message}
              </p>
              <Link to="/login" className="btn-secondary w-full block text-center">
                {t('auth.back_to_signin')}
              </Link>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label htmlFor="forgot-email" className="label">
                  {t('auth.email')}
                </label>
                <input
                  id="forgot-email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="input"
                  placeholder={t('auth.placeholder_email')}
                  required
                  // biome-ignore lint/a11y/noAutofocus: single-purpose auth form; focusing its first field is the expected entry point
                  autoFocus
                />
              </div>
              {error && (
                <p className="text-body text-danger-600" role="alert">
                  {error}
                </p>
              )}
              <button type="submit" className="btn-primary w-full" disabled={loading}>
                {loading ? t('auth.sending') : t('auth.send_reset')}
              </button>
              <Link
                to="/login"
                className="block text-center text-body text-ink-500 hover:text-ink-900 transition-colors duration-(--duration-base)"
              >
                {t('auth.back_to_signin')}
              </Link>
            </form>
          )}
        </div>
      </div>
    </div>
  )
}
