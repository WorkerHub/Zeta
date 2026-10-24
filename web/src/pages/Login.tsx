import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Eye, EyeOff, Globe } from 'lucide-react'
import { authApi } from '../lib/api'
import { useAuthContext } from '../hooks/useAuth'
import { useLocale } from '../hooks/useLocale'
import Logo from '../components/Logo'
import TwoFactorModal from '../components/TwoFactorModal'
import type { User } from '../types'

export default function Login() {
  const navigate = useNavigate()
  const { login } = useAuthContext()
  const { t, locale, changeLocale } = useLocale()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPw, setShowPw] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [pending, setPending] = useState<{ pendingToken: string } | null>(null)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      const res = await authApi.login({ email, password })
      if (res.requires2fa && res.pendingToken) {
        setPending({ pendingToken: res.pendingToken })
      } else if (res.accessToken && res.user) {
        login(res.accessToken, res.user)
        navigate('/query')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t('errors.login_failed'))
    } finally {
      setLoading(false)
    }
  }

  function handle2faSuccess(token: string, user: User) {
    login(token, user)
    navigate('/query')
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
        {/* Logo */}
        <div className="flex items-center justify-center gap-2 mb-8">
          <Logo size="md" />
          <span className="text-title text-ink-900">{t('app.name')}</span>
        </div>

        <div className="card p-6">
          <h1 className="text-heading text-ink-900 mb-6">{t('auth.signin')}</h1>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label htmlFor="login-email" className="label">
                {t('auth.email')}
              </label>
              <input
                id="login-email"
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
            <div>
              <label htmlFor="login-password" className="label">
                {t('auth.password')}
              </label>
              <div className="relative">
                <input
                  id="login-password"
                  type={showPw ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="input pr-10"
                  placeholder="••••••••"
                  required
                />
                <button
                  type="button"
                  onClick={() => setShowPw(!showPw)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-ink-400 hover:text-ink-700 transition-colors duration-(--duration-base)"
                >
                  {showPw ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
            </div>

            {error && <p className="text-body text-danger-600">{error}</p>}

            <button type="submit" className="btn-primary w-full" disabled={loading}>
              {loading ? t('auth.signing_in') : t('auth.signin')}
            </button>
          </form>

          <div className="mt-4 flex items-center justify-between text-body">
            <Link
              to="/forgot-password"
              className="text-ink-500 hover:text-ink-900 transition-colors duration-(--duration-base)"
            >
              {t('auth.forgot_password')}
            </Link>
            <Link
              to="/register"
              className="text-brand-600 hover:text-brand-700 dark:text-brand-400 dark:hover:text-brand-300 transition-colors duration-(--duration-base)"
            >
              {t('auth.create_account')}
            </Link>
          </div>
        </div>
      </div>

      {pending && (
        <TwoFactorModal
          pendingToken={pending.pendingToken}
          onSuccess={handle2faSuccess}
          onCancel={() => setPending(null)}
        />
      )}
    </div>
  )
}
