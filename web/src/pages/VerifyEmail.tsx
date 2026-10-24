import { useEffect, useState } from 'react'
import { useSearchParams, Link } from 'react-router-dom'
import { CheckCircle, XCircle } from 'lucide-react'
import { authApi } from '../lib/api'
import { useLocale } from '../hooks/useLocale'
import Logo from '../components/Logo'

export default function VerifyEmail() {
  const { t } = useLocale()
  const [params] = useSearchParams()
  const token = params.get('token') ?? ''
  const [status, setStatus] = useState<'loading' | 'success' | 'error'>('loading')
  const [message, setMessage] = useState('')

  useEffect(() => {
    if (!token) {
      setStatus('error')
      setMessage(t('errors.no_token'))
      return
    }
    authApi
      .verifyEmail(token)
      .then((res) => {
        setStatus('success')
        setMessage(res.message)
      })
      .catch((err) => {
        setStatus('error')
        setMessage(err instanceof Error ? err.message : t('errors.verify_failed'))
      })
  }, [token, t])

  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-ink-50">
      <div className="w-full max-w-sm">
        <div className="flex items-center justify-center gap-2 mb-8">
          <Logo size="md" />
          <span className="text-title text-ink-900">{t('app.name')}</span>
        </div>

        <div className="card p-6 text-center">
          {status === 'loading' && <p className="text-body text-ink-500">{t('auth.verify_title')}</p>}
          {status === 'success' && (
            <div className="space-y-4">
              <CheckCircle size={40} className="mx-auto text-success-600" />
              <p className="text-body text-ink-900">{message}</p>
              <Link to="/login" className="btn-primary inline-block">
                {t('auth.verify_success')}
              </Link>
            </div>
          )}
          {status === 'error' && (
            <div className="space-y-4">
              <XCircle size={40} className="mx-auto text-danger-600" />
              <p className="text-body text-danger-600">{message}</p>
              <Link to="/login" className="btn-secondary inline-block">
                {t('auth.verify_fail')}
              </Link>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
