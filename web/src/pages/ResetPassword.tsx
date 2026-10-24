import { useState } from 'react'
import { Link, useSearchParams, useNavigate } from 'react-router-dom'
import { authApi } from '../lib/api'
import { useLocale } from '../hooks/useLocale'
import Logo from '../components/Logo'

export default function ResetPassword() {
  const { t } = useLocale()
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const token = params.get('token') ?? ''
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (password !== confirm) {
      setError(t('auth.pw_mismatch'))
      return
    }
    if (password.length < 8) {
      setError(t('auth.pw_min_error'))
      return
    }
    setError('')
    setLoading(true)
    try {
      await authApi.resetPassword({ token, password })
      navigate('/login', { state: { message: t('auth.reset_success') } })
    } catch (err) {
      setError(err instanceof Error ? err.message : t('errors.reset_failed'))
    } finally {
      setLoading(false)
    }
  }

  if (!token) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4 bg-ink-50">
        <div className="card p-6 text-center">
          <p className="text-body text-danger-600 mb-4">{t('auth.invalid_reset')}</p>
          <Link to="/forgot-password" className="btn-primary">
            {t('auth.request_new')}
          </Link>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-ink-50">
      <div className="w-full max-w-sm">
        <div className="flex items-center justify-center gap-2 mb-8">
          <Logo size="md" />
          <span className="text-title text-ink-900">{t('app.name')}</span>
        </div>

        <div className="card p-6">
          <h1 className="text-heading text-ink-900 mb-6">{t('auth.reset_title')}</h1>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label htmlFor="reset-password" className="label">
                {t('auth.new_password')}
              </label>
              <input
                id="reset-password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="input"
                placeholder={t('auth.pw_min')}
                required
                // biome-ignore lint/a11y/noAutofocus: single-purpose auth form; focusing its first field is the expected entry point
                autoFocus
              />
            </div>
            <div>
              <label htmlFor="reset-confirm" className="label">
                {t('auth.confirm_password')}
              </label>
              <input
                id="reset-confirm"
                type="password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                className="input"
                placeholder={t('auth.repeat_password')}
                required
              />
            </div>
            {error && <p className="text-body text-danger-600">{error}</p>}
            <button type="submit" className="btn-primary w-full" disabled={loading}>
              {loading ? t('auth.saving') : t('auth.set_password')}
            </button>
          </form>
        </div>
      </div>
    </div>
  )
}
