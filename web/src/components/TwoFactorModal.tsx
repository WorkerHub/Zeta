import { useState } from 'react'
import { X, Smartphone, Mail, Fingerprint } from 'lucide-react'
import { startAuthentication } from '@simplewebauthn/browser'
import { authApi } from '../lib/api'
import { useLocale } from '../hooks/useLocale'
import type { User } from '../types'

type Method = 'totp' | 'email-otp' | 'passkey'

interface Props {
  pendingToken: string
  onSuccess: (accessToken: string, user: User) => void
  onCancel: () => void
}

export default function TwoFactorModal({ pendingToken, onSuccess, onCancel }: Props) {
  const { t } = useLocale()
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
      setError(err instanceof Error ? err.message : t('errors.send_otp_failed'))
    } finally {
      setLoading(false)
    }
  }

  async function verify() {
    if (!code.trim()) return
    setError('')
    setLoading(true)
    try {
      const res =
        method === 'totp'
          ? await authApi.verify2faTotp({ pendingToken, code })
          : await authApi.verifyEmailOtp({ pendingToken, code })
      onSuccess(res.accessToken, res.user)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('errors.verify_failed'))
    } finally {
      setLoading(false)
    }
  }

  async function signInWithPasskey() {
    setLoading(true)
    setError('')
    try {
      const options = await authApi.passkey2faOptions({ pendingToken })
      const credential = await startAuthentication({
        optionsJSON: options as unknown as Parameters<typeof startAuthentication>[0]['optionsJSON'],
      })
      const res = await authApi.verify2faPasskey({ pendingToken, credential })
      onSuccess(res.accessToken, res.user)
    } catch (err) {
      if (err instanceof Error && err.name === 'NotAllowedError') {
        setError(t('errors.passkey_cancelled'))
      } else {
        setError(err instanceof Error ? err.message : t('errors.passkey_failed'))
      }
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
      <div className="card w-full max-w-sm p-6 shadow-2xl">
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">{t('2fa.title')}</h2>
          <button type="button" onClick={onCancel} className="btn-ghost p-1.5 rounded-lg">
            <X size={16} />
          </button>
        </div>

        {/* Method selector */}
        <div className="flex gap-2 mb-6">
          {(['totp', 'email-otp', 'passkey'] as Method[]).map((m) => (
            <button
              type="button"
              key={m}
              onClick={() => {
                setMethod(m)
                setCode('')
                setError('')
                setOtpSent(false)
              }}
              className={`flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg text-xs font-medium border transition-colors ${method === m ? 'bg-blue-600 border-blue-600 text-white' : 'bg-zinc-100 border-zinc-200 text-zinc-500 hover:text-zinc-800 dark:bg-zinc-800 dark:border-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200'}`}
            >
              {m === 'totp' ? (
                <>
                  <Smartphone size={13} /> {t('2fa.authenticator')}
                </>
              ) : m === 'email-otp' ? (
                <>
                  <Mail size={13} /> {t('2fa.email_otp')}
                </>
              ) : (
                <>
                  <Fingerprint size={13} /> {t('2fa.passkey')}
                </>
              )}
            </button>
          ))}
        </div>

        {method === 'totp' && (
          <div className="space-y-4">
            <div>
              <label htmlFor="twofa-totp-code" className="label">
                {t('2fa.enter_code')}
              </label>
              <input
                id="twofa-totp-code"
                type="text"
                inputMode="numeric"
                pattern="\d{6}"
                maxLength={6}
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                className="input text-center text-2xl tracking-[0.5em] font-mono"
                placeholder="000000"
                // biome-ignore lint/a11y/noAutofocus: focus moves into the dialog that just opened
                autoFocus
              />
            </div>
          </div>
        )}

        {method === 'email-otp' && (
          <div className="space-y-4">
            {!otpSent ? (
              <button type="button" onClick={sendOtp} disabled={loading} className="btn-secondary w-full gap-2">
                <Mail size={14} />
                {loading ? t('2fa.sending') : t('2fa.send_code')}
              </button>
            ) : (
              <div>
                <p className="text-sm text-emerald-400 mb-4">{t('2fa.code_sent')}</p>
                <label htmlFor="twofa-email-code" className="label">
                  {t('2fa.enter_code')}
                </label>
                <input
                  id="twofa-email-code"
                  type="text"
                  inputMode="numeric"
                  pattern="\d{6}"
                  maxLength={6}
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                  className="input text-center text-2xl tracking-[0.5em] font-mono"
                  placeholder="000000"
                  // biome-ignore lint/a11y/noAutofocus: focus moves into the dialog that just opened
                  autoFocus
                />
              </div>
            )}
          </div>
        )}

        {method === 'passkey' && (
          <div className="flex flex-col items-center py-2">
            <button type="button" onClick={signInWithPasskey} disabled={loading} className="btn-secondary w-full gap-2">
              <Fingerprint size={14} />
              {loading ? t('profile.passkey_waiting') : t('2fa.use_passkey')}
            </button>
          </div>
        )}

        {error && <p className="text-sm text-red-400 mt-3">{error}</p>}

        <div className="mt-6 flex gap-3">
          <button type="button" onClick={onCancel} className="btn-secondary flex-1">
            {t('2fa.cancel')}
          </button>
          {(method === 'totp' || (method === 'email-otp' && otpSent)) && (
            <button type="button" onClick={verify} disabled={loading || code.length < 6} className="btn-primary flex-1">
              {loading ? t('2fa.verifying') : t('2fa.verify')}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
