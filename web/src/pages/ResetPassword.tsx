import { useState } from 'react'
import { Link, useSearchParams, useNavigate } from 'react-router-dom'
import { Database } from 'lucide-react'
import { authApi } from '../lib/api'

export default function ResetPassword() {
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const token = params.get('token') ?? ''
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (password !== confirm) { setError('Passwords do not match'); return }
    if (password.length < 8) { setError('Password must be at least 8 characters'); return }
    setError('')
    setLoading(true)
    try {
      await authApi.resetPassword({ token, password })
      navigate('/login', { state: { message: 'Password reset successfully. You can now sign in.' } })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Reset failed')
    } finally {
      setLoading(false)
    }
  }

  if (!token) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4">
        <div className="card p-6 text-center">
          <p className="text-red-400 mb-4">Invalid reset link.</p>
          <Link to="/forgot-password" className="btn-primary">Request a new link</Link>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <div className="w-full max-w-sm">
        <div className="flex items-center justify-center gap-2 mb-8">
          <div className="w-9 h-9 bg-blue-600 rounded-lg flex items-center justify-center">
            <Database size={20} className="text-white" />
          </div>
          <span className="text-xl font-semibold text-zinc-100">D1 Studio</span>
        </div>

        <div className="card p-6">
          <h1 className="text-lg font-semibold text-zinc-100 mb-6">Set new password</h1>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="label">New password</label>
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)}
                className="input" placeholder="Min. 8 characters" required autoFocus />
            </div>
            <div>
              <label className="label">Confirm password</label>
              <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)}
                className="input" placeholder="Repeat password" required />
            </div>
            {error && <p className="text-sm text-red-400">{error}</p>}
            <button type="submit" className="btn-primary w-full" disabled={loading}>
              {loading ? 'Saving…' : 'Set password'}
            </button>
          </form>
        </div>
      </div>
    </div>
  )
}
