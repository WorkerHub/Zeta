import { useState } from 'react'
import { Link, useSearchParams, useNavigate } from 'react-router-dom'
import { Database } from 'lucide-react'
import { authApi } from '../lib/api'
import { useLocale } from '../hooks/useLocale'

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
    if (password !== confirm) { setError(t('auth.pw_mismatch')); return }
    if (password.length < 8) { setError(t('auth.pw_min_error')); return }
    setError('')
    setLoading(true)
    try {
      await authApi.resetPassword({ token, password })
      navigate('/login', { state: { message: t('auth.reset_success') } })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Reset failed')
    } finally {
      setLoading(false)
    }
  }

  if (!token) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4 bg-zinc-50 dark:bg-zinc-950">
        <div className="card p-6 text-center">
          <p className="text-red-400 mb-4">{t('auth.invalid_reset')}</p>
          <Link to="/forgot-password" className="btn-primary">{t('auth.request_new')}</Link>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-zinc-50 dark:bg-zinc-950">
      <div className="w-full max-w-sm">
        <div className="flex items-center justify-center gap-2 mb-8">
          <div className="w-9 h-9 bg-blue-600 rounded-lg flex items-center justify-center">
            <Database size={20} className="text-white" />
          </div>
          <span className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">{t('app.name')}</span>
        </div>

        <div className="card p-6">
          <h1 className="text-lg font-semibold text-zinc-900 mb-6 dark:text-zinc-100">{t('auth.reset_title')}</h1>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="label">{t('auth.new_password')}</label>
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)}
                className="input" placeholder={t('auth.pw_min')} required autoFocus />
            </div>
            <div>
              <label className="label">{t('auth.confirm_password')}</label>
              <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)}
                className="input" placeholder={t('auth.repeat_password')} required />
            </div>
            {error && <p className="text-sm text-red-400">{error}</p>}
            <button type="submit" className="btn-primary w-full" disabled={loading}>
              {loading ? t('auth.saving') : t('auth.set_password')}
            </button>
          </form>
        </div>
      </div>
    </div>
  )
}
