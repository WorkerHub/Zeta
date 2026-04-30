import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Database, Eye, EyeOff } from 'lucide-react'
import { authApi } from '../lib/api'
import { useAuthContext } from '../hooks/useAuth'
import TwoFactorModal from '../components/TwoFactorModal'
import type { User } from '../types'

export default function Login() {
  const navigate = useNavigate()
  const { login } = useAuthContext()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPw, setShowPw] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [pending, setPending] = useState<{ pendingToken: string; userId: string } | null>(null)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      const res = await authApi.login({ email, password })
      if (res.requires2fa && res.pendingToken && res.userId) {
        setPending({ pendingToken: res.pendingToken, userId: res.userId })
      } else if (res.accessToken && res.user) {
        login(res.accessToken, res.user)
        navigate('/query')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed')
    } finally {
      setLoading(false)
    }
  }

  function handle2faSuccess(token: string, user: User) {
    login(token, user)
    navigate('/query')
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-zinc-50 dark:bg-zinc-950">
      <div className="w-full max-w-sm">
        {/* Logo */}
        <div className="flex items-center justify-center gap-2 mb-8">
          <div className="w-9 h-9 bg-blue-600 rounded-lg flex items-center justify-center">
            <Database size={20} className="text-white" />
          </div>
          <span className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">D1 Studio</span>
        </div>

        <div className="card p-6">
          <h1 className="text-lg font-semibold text-zinc-900 mb-6 dark:text-zinc-100">Sign in</h1>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="label">Email</label>
              <input
                type="email" value={email} onChange={(e) => setEmail(e.target.value)}
                className="input" placeholder="you@example.com" required autoFocus
              />
            </div>
            <div>
              <label className="label">Password</label>
              <div className="relative">
                <input
                  type={showPw ? 'text' : 'password'} value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="input pr-10" placeholder="••••••••" required
                />
                <button
                  type="button" onClick={() => setShowPw(!showPw)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-300"
                >
                  {showPw ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
            </div>

            {error && <p className="text-sm text-red-400">{error}</p>}

            <button type="submit" className="btn-primary w-full" disabled={loading}>
              {loading ? 'Signing in…' : 'Sign in'}
            </button>
          </form>

          <div className="mt-4 flex items-center justify-between text-sm">
            <Link to="/forgot-password" className="text-zinc-500 hover:text-zinc-300 transition-colors">
              Forgot password?
            </Link>
            <Link to="/register" className="text-blue-400 hover:text-blue-300 transition-colors">
              Create account
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
