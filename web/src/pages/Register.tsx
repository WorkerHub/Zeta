import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Database } from 'lucide-react'
import { authApi } from '../lib/api'

export default function Register() {
  const navigate = useNavigate()
  const [form, setForm] = useState({ name: '', email: '', password: '' })
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    if (form.password.length < 8) { setError('Password must be at least 8 characters'); return }
    setLoading(true)
    try {
      await authApi.register(form)
      setSuccess('Account created! Check your email to verify your address.')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Registration failed')
    } finally {
      setLoading(false)
    }
  }

  const field = (key: keyof typeof form) => ({
    value: form[key],
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [key]: e.target.value }),
  })

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
          <h1 className="text-lg font-semibold text-zinc-100 mb-6">Create account</h1>

          {success ? (
            <div className="space-y-4">
              <p className="text-sm text-emerald-400">{success}</p>
              <button onClick={() => navigate('/login')} className="btn-primary w-full">
                Go to sign in
              </button>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="label">Name</label>
                <input type="text" {...field('name')} className="input" placeholder="Jane Doe" required autoFocus />
              </div>
              <div>
                <label className="label">Email</label>
                <input type="email" {...field('email')} className="input" placeholder="you@example.com" required />
              </div>
              <div>
                <label className="label">Password</label>
                <input type="password" {...field('password')} className="input" placeholder="Min. 8 characters" required />
              </div>

              {error && <p className="text-sm text-red-400">{error}</p>}

              <button type="submit" className="btn-primary w-full" disabled={loading}>
                {loading ? 'Creating account…' : 'Create account'}
              </button>
            </form>
          )}

          <p className="mt-4 text-sm text-center text-zinc-500">
            Already have an account?{' '}
            <Link to="/login" className="text-blue-400 hover:text-blue-300">Sign in</Link>
          </p>
        </div>
      </div>
    </div>
  )
}
