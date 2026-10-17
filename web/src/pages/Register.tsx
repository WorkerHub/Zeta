import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Database, Globe } from 'lucide-react'
import { authApi } from '../lib/api'
import { useLocale } from '../hooks/useLocale'

export default function Register() {
  const navigate = useNavigate()
  const { t, locale, changeLocale } = useLocale()
  const [form, setForm] = useState({ name: '', email: '', password: '' })
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    if (form.password.length < 8) {
      setError(t('auth.pw_min_error'))
      return
    }
    setLoading(true)
    try {
      await authApi.register(form)
      setSuccess(t('auth.registration_success'))
    } catch (err) {
      setError(err instanceof Error ? err.message : t('errors.register_failed'))
    } finally {
      setLoading(false)
    }
  }

  const field = (key: keyof typeof form) => ({
    value: form[key],
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [key]: e.target.value }),
  })

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

        <div className="card p-6">
          <h1 className="text-lg font-semibold text-zinc-900 mb-6 dark:text-zinc-100">{t('auth.register')}</h1>

          {success ? (
            <div className="space-y-4">
              <p className="text-sm text-emerald-400">{success}</p>
              <button type="button" onClick={() => navigate('/login')} className="btn-primary w-full">
                {t('auth.go_to_signin')}
              </button>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label htmlFor="register-name" className="label">
                  {t('auth.name')}
                </label>
                <input
                  id="register-name"
                  type="text"
                  {...field('name')}
                  className="input"
                  placeholder={t('auth.placeholder_name')}
                  required
                  // biome-ignore lint/a11y/noAutofocus: single-purpose auth form; focusing its first field is the expected entry point
                  autoFocus
                />
              </div>
              <div>
                <label htmlFor="register-email" className="label">
                  {t('auth.email')}
                </label>
                <input
                  id="register-email"
                  type="email"
                  {...field('email')}
                  className="input"
                  placeholder={t('auth.placeholder_email')}
                  required
                />
              </div>
              <div>
                <label htmlFor="register-password" className="label">
                  {t('auth.password')}
                </label>
                <input
                  id="register-password"
                  type="password"
                  {...field('password')}
                  className="input"
                  placeholder={t('auth.pw_min')}
                  required
                />
              </div>

              {error && <p className="text-sm text-red-400">{error}</p>}

              <button type="submit" className="btn-primary w-full" disabled={loading}>
                {loading ? t('auth.creating_account') : t('auth.create_account')}
              </button>
            </form>
          )}

          <p className="mt-4 text-sm text-center text-zinc-500">
            {t('auth.have_account')}{' '}
            <Link to="/login" className="text-blue-400 hover:text-blue-300">
              {t('auth.signin')}
            </Link>
          </p>
        </div>
      </div>
    </div>
  )
}
