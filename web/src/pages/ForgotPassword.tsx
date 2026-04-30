import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Database } from 'lucide-react'
import { authApi } from '../lib/api'

export default function ForgotPassword() {
  const [email, setEmail] = useState('')
  const [message, setMessage] = useState('')
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    try {
      const res = await authApi.forgotPassword({ email })
      setMessage(res.message)
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'An error occurred')
    } finally {
      setLoading(false)
    }
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
          <h1 className="text-lg font-semibold text-zinc-100 mb-2">Forgot password</h1>
          <p className="text-sm text-zinc-500 mb-6">Enter your email and we'll send a reset link.</p>

          {message ? (
            <div className="space-y-4">
              <p className="text-sm text-zinc-300">{message}</p>
              <Link to="/login" className="btn-secondary w-full block text-center">Back to sign in</Link>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="label">Email</label>
                <input
                  type="email" value={email} onChange={(e) => setEmail(e.target.value)}
                  className="input" placeholder="you@example.com" required autoFocus
                />
              </div>
              <button type="submit" className="btn-primary w-full" disabled={loading}>
                {loading ? 'Sending…' : 'Send reset link'}
              </button>
              <Link to="/login" className="block text-center text-sm text-zinc-500 hover:text-zinc-300">
                Back to sign in
              </Link>
            </form>
          )}
        </div>
      </div>
    </div>
  )
}
