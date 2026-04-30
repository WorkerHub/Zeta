import { useEffect, useState } from 'react'
import { useSearchParams, Link } from 'react-router-dom'
import { Database, CheckCircle, XCircle } from 'lucide-react'
import { authApi } from '../lib/api'

export default function VerifyEmail() {
  const [params] = useSearchParams()
  const token = params.get('token') ?? ''
  const [status, setStatus] = useState<'loading' | 'success' | 'error'>('loading')
  const [message, setMessage] = useState('')

  useEffect(() => {
    if (!token) { setStatus('error'); setMessage('No token provided.'); return }
    authApi.verifyEmail(token)
      .then((res) => { setStatus('success'); setMessage(res.message) })
      .catch((err) => { setStatus('error'); setMessage(err instanceof Error ? err.message : 'Verification failed') })
  }, [token])

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <div className="w-full max-w-sm">
        <div className="flex items-center justify-center gap-2 mb-8">
          <div className="w-9 h-9 bg-blue-600 rounded-lg flex items-center justify-center">
            <Database size={20} className="text-white" />
          </div>
          <span className="text-xl font-semibold text-zinc-100">D1 Studio</span>
        </div>

        <div className="card p-6 text-center">
          {status === 'loading' && <p className="text-zinc-400">Verifying…</p>}
          {status === 'success' && (
            <div className="space-y-4">
              <CheckCircle size={40} className="mx-auto text-emerald-400" />
              <p className="text-zinc-200">{message}</p>
              <Link to="/login" className="btn-primary inline-block">Sign in</Link>
            </div>
          )}
          {status === 'error' && (
            <div className="space-y-4">
              <XCircle size={40} className="mx-auto text-red-400" />
              <p className="text-red-400">{message}</p>
              <Link to="/login" className="btn-secondary inline-block">Back to sign in</Link>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
