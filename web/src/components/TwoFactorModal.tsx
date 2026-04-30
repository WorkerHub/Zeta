import { useState } from 'react'
import { X, Smartphone, Mail, Key } from 'lucide-react'
import { authApi } from '../lib/api'
import type { User } from '../types'

type Method = 'totp' | 'email-otp' | 'passkey'

interface Props {
  pendingToken: string
  onSuccess: (accessToken: string, user: User) => void
  onCancel: () => void
}

export default function TwoFactorModal({ pendingToken, onSuccess, onCancel }: Props) {
  const [method, setMethod] = useState<Method>('totp')
  const [code, setCode] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [otpSent, setOtpSent] = useState(false)

  async function sendOtp() {
    setLoading(true)
    setError('')
    try {
      await authApi.sendEmailOtp({ pendingToken })
      setOtpSent(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send OTP')
    } finally {
      setLoading(false)
    }
  }

  async function verify() {
    if (!code.trim()) return
    setError('')
    setLoading(true)
    try {
      let res
      if (method === 'totp') {
        res = await authApi.verify2faTotp({ pendingToken, code })
      } else {
        res = await authApi.verifyEmailOtp({ pendingToken, code })
      }
      onSuccess(res.accessToken, res.user)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Verification failed')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
      <div className="card w-full max-w-sm p-6 shadow-2xl">
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">Two-factor verification</h2>
          <button onClick={onCancel} className="btn-ghost p-1.5 rounded-lg">
            <X size={16} />
          </button>
        </div>

        {/* Method selector */}
        <div className="flex gap-2 mb-6">
          {(['totp', 'email-otp'] as Method[]).map((m) => (
            <button
              key={m}
              onClick={() => { setMethod(m); setCode(''); setError(''); setOtpSent(false) }}
              className={`flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg text-xs font-medium border transition-colors ${method === m ? 'bg-blue-600 border-blue-600 text-white' : 'bg-zinc-100 border-zinc-200 text-zinc-500 hover:text-zinc-800 dark:bg-zinc-800 dark:border-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200'}`}
            >
              {m === 'totp' ? <><Smartphone size={13} /> Authenticator</> : <><Mail size={13} /> Email OTP</>}
            </button>
          ))}
        </div>

        {method === 'totp' && (
          <div className="space-y-4">
            <div>
              <label className="label">Enter 6-digit code</label>
              <input
                type="text" inputMode="numeric" pattern="\d{6}" maxLength={6}
                value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                className="input text-center text-2xl tracking-[0.5em] font-mono"
                placeholder="000000" autoFocus
              />
            </div>
          </div>
        )}

        {method === 'email-otp' && (
          <div className="space-y-4">
            {!otpSent ? (
              <button onClick={sendOtp} disabled={loading} className="btn-secondary w-full gap-2">
                <Mail size={14} />
                {loading ? 'Sending…' : 'Send code to email'}
              </button>
            ) : (
              <div>
                <p className="text-sm text-emerald-400 mb-4">Code sent! Check your email.</p>
                <label className="label">Enter 6-digit code</label>
                <input
                  type="text" inputMode="numeric" pattern="\d{6}" maxLength={6}
                  value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                  className="input text-center text-2xl tracking-[0.5em] font-mono"
                  placeholder="000000" autoFocus
                />
              </div>
            )}
          </div>
        )}

        {error && <p className="text-sm text-red-400 mt-3">{error}</p>}

        <div className="mt-6 flex gap-3">
          <button onClick={onCancel} className="btn-secondary flex-1">Cancel</button>
          {(method === 'totp' || (method === 'email-otp' && otpSent)) && (
            <button onClick={verify} disabled={loading || code.length < 6} className="btn-primary flex-1">
              {loading ? 'Verifying…' : 'Verify'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
