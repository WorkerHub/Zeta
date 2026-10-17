import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { Database, ArrowLeft, Shield, Key, Smartphone, Trash2, Plus, Eye, EyeOff, Copy, CheckCircle, Fingerprint } from 'lucide-react'
import QRCode from 'qrcode'
import { startRegistration } from '@simplewebauthn/browser'
import { profileApi } from '../lib/api'
import { useLocale } from '../hooks/useLocale'
import type { User } from '../types'

export default function ProfilePage() {
  const { t } = useLocale()
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(true)

  // Change password
  const [pwForm, setPwForm] = useState({ currentPassword: '', newPassword: '', confirm: '' })
  const [pwError, setPwError] = useState('')
  const [pwSuccess, setPwSuccess] = useState('')
  const [pwLoading, setPwLoading] = useState(false)

  // TOTP setup
  const [totpSetup, setTotpSetup] = useState<{ secret: string; uri: string } | null>(null)
  const [totpQr, setTotpQr] = useState<string | null>(null)
  const [totpCode, setTotpCode] = useState('')
  const [totpError, setTotpError] = useState('')
  const [totpLoading, setTotpLoading] = useState(false)
  const [showSecret, setShowSecret] = useState(false)
  const [copied, setCopied] = useState(false)

  // Passkey
  const [passkeyLoading, setPasskeyLoading] = useState(false)
  const [passkeyError, setPasskeyError] = useState('')

  // Removing a second factor needs the current password
  const [removal, setRemoval] = useState<{ kind: 'totp' | 'passkey'; id: string } | null>(null)
  const [removalPassword, setRemovalPassword] = useState('')
  const [removalError, setRemovalError] = useState('')
  const [removalLoading, setRemovalLoading] = useState(false)

  useEffect(() => {
    profileApi.me().then(setUser).finally(() => setLoading(false))
  }, [])

  // Generate QR code data URL when TOTP URI is available
  useEffect(() => {
    if (!totpSetup?.uri) { setTotpQr(null); return }
    QRCode.toDataURL(totpSetup.uri, { width: 176, margin: 1, color: { dark: '#000000', light: '#ffffff' } })
      .then(setTotpQr)
      .catch(() => setTotpQr(null))
  }, [totpSetup?.uri])

  async function savePassword(e: React.FormEvent) {
    e.preventDefault()
    if (pwForm.newPassword !== pwForm.confirm) { setPwError(t('auth.pw_mismatch')); return }
    if (pwForm.newPassword.length < 8) { setPwError(t('auth.pw_min_error')); return }
    setPwError(''); setPwSuccess(''); setPwLoading(true)
    try {
      await profileApi.changePassword({ currentPassword: pwForm.currentPassword, newPassword: pwForm.newPassword })
      setPwSuccess(t('profile.password_changed'))
      setPwForm({ currentPassword: '', newPassword: '', confirm: '' })
    } catch (err) {
      setPwError(err instanceof Error ? err.message : t('errors.generic'))
    } finally {
      setPwLoading(false)
    }
  }

  async function startTotpSetup() {
    setTotpLoading(true); setTotpError('')
    try {
      const res = await profileApi.setupTotp()
      setTotpSetup(res)
    } catch (err) {
      setTotpError(err instanceof Error ? err.message : t('errors.generic'))
    } finally {
      setTotpLoading(false)
    }
  }

  async function confirmTotp() {
    setTotpError(''); setTotpLoading(true)
    try {
      await profileApi.confirmTotp({ code: totpCode })
      setTotpSetup(null); setTotpCode('')
      const updated = await profileApi.me()
      setUser(updated)
    } catch (err) {
      setTotpError(err instanceof Error ? err.message : t('errors.invalid_code'))
    } finally {
      setTotpLoading(false)
    }
  }

  function askRemoval(kind: 'totp' | 'passkey', id: string) {
    setRemoval({ kind, id }); setRemovalPassword(''); setRemovalError('')
  }

  async function confirmRemoval(e: React.FormEvent) {
    e.preventDefault()
    if (!removal) return
    setRemovalError(''); setRemovalLoading(true)
    try {
      if (removal.kind === 'totp') await profileApi.deleteTotp(removal.id, removalPassword)
      else await profileApi.deletePasskey(removal.id, removalPassword)
      setRemoval(null); setRemovalPassword('')
      setUser(await profileApi.me())
    } catch (err) {
      setRemovalError(err instanceof Error ? err.message : t('errors.generic'))
    } finally {
      setRemovalLoading(false)
    }
  }

  function copySecret() {
    if (totpSetup?.secret) {
      navigator.clipboard.writeText(totpSetup.secret)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }
  }

  async function registerPasskey() {
    setPasskeyLoading(true); setPasskeyError('')
    try {
      const options = await profileApi.passkeyRegisterOptions()
      const result = await startRegistration({ optionsJSON: options as unknown as Parameters<typeof startRegistration>[0]['optionsJSON'] })
      await profileApi.passkeyRegisterVerify(result)
      const updated = await profileApi.me()
      setUser(updated)
    } catch (err) {
      if (err instanceof Error && err.name === 'NotAllowedError') {
        setPasskeyError(t('profile.passkey_cancelled'))
      } else {
        setPasskeyError(err instanceof Error ? err.message : t('profile.passkey_failed'))
      }
    } finally {
      setPasskeyLoading(false)
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-zinc-50 dark:bg-zinc-950 flex items-center justify-center text-zinc-500 text-sm">{t('common.loading')}</div>
    )
  }

  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-zinc-950">
      {/* Header */}
      <header className="px-4 py-3 border-b border-zinc-200 dark:border-zinc-800 flex items-center gap-3">
        <div className="w-7 h-7 bg-blue-600 rounded-md flex items-center justify-center">
          <Database size={15} className="text-white" />
        </div>
        <span className="font-semibold text-zinc-900 dark:text-zinc-100">{t('app.name')}</span>
        <div className="flex-1" />
        <Link to="/query" className="btn-ghost btn-sm gap-1.5">
          <ArrowLeft size={14} /> {t('profile.back_to_query')}
        </Link>
      </header>

      <div className="max-w-2xl mx-auto p-4 sm:p-6 space-y-6">
        <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">{t('profile.title')}</h1>

        {/* Account info */}
        <div className="card p-5">
          <h2 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300 mb-4 flex items-center gap-2">
            <Shield size={15} className="text-zinc-500" /> {t('profile.account')}
          </h2>
          <div className="space-y-2 text-sm">
            <div className="flex items-center justify-between">
              <span className="text-zinc-500">{t('auth.name')}</span>
              <span className="text-zinc-800 dark:text-zinc-200">{user?.name}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-zinc-500">{t('auth.email')}</span>
              <span className="text-zinc-800 dark:text-zinc-200">{user?.email}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-zinc-500">{t('profile.role')}</span>
              <span className={`badge ${user?.role === 'admin' ? 'badge-blue' : 'badge-zinc'}`}>{user?.role}</span>
            </div>
          </div>
        </div>

        {/* Change password */}
        <div className="card p-5">
          <h2 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300 mb-4 flex items-center gap-2">
            <Key size={15} className="text-zinc-500" /> {t('profile.change_password')}
          </h2>
          <form onSubmit={savePassword} className="space-y-4">
            <div>
              <label htmlFor="profile-current-password" className="label">{t('profile.current_password')}</label>
              <input id="profile-current-password" type="password" className="input" value={pwForm.currentPassword}
                onChange={(e) => setPwForm({ ...pwForm, currentPassword: e.target.value })} required />
            </div>
            <div>
              <label htmlFor="profile-new-password" className="label">{t('profile.new_password')}</label>
              <input id="profile-new-password" type="password" className="input" value={pwForm.newPassword}
                onChange={(e) => setPwForm({ ...pwForm, newPassword: e.target.value })} required placeholder={t('auth.pw_min')} />
            </div>
            <div>
              <label htmlFor="profile-confirm-password" className="label">{t('profile.confirm_new_password')}</label>
              <input id="profile-confirm-password" type="password" className="input" value={pwForm.confirm}
                onChange={(e) => setPwForm({ ...pwForm, confirm: e.target.value })} required />
            </div>
            {pwError && <p className="text-sm text-red-400">{pwError}</p>}
            {pwSuccess && <p className="text-sm text-emerald-400">{pwSuccess}</p>}
            <button type="submit" className="btn-primary" disabled={pwLoading}>
              {pwLoading ? t('profile.saving') : t('profile.update_password')}
            </button>
          </form>
        </div>

        {/* TOTP */}
        <div className="card p-5">
          <h2 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300 mb-4 flex items-center gap-2">
            <Smartphone size={15} className="text-zinc-500" /> {t('profile.totp_title')}
          </h2>

          {user?.totpCredentials && user.totpCredentials.length > 0 && (
            <ul className="space-y-2 mb-4">
              {user.totpCredentials.map((cred) => (
                <li key={cred.id} className="flex items-center justify-between bg-zinc-100 dark:bg-zinc-800 rounded-lg px-4 py-2.5">
                  <div>
                    <p className="text-sm text-zinc-800 dark:text-zinc-200">{cred.name}</p>
                    <p className="text-xs text-zinc-500">{t('profile.totp_added')} {new Date(cred.created_at * 1000).toLocaleDateString()}</p>
                  </div>
                  <button type="button" onClick={() => askRemoval('totp', cred.id)} className="btn-ghost p-1.5 text-red-400">
                    <Trash2 size={14} />
                  </button>
                </li>
              ))}
            </ul>
          )}

          {!totpSetup ? (
            <button type="button" onClick={startTotpSetup} disabled={totpLoading} className="btn-secondary gap-2">
              <Plus size={14} /> {t('profile.totp_add')}
            </button>
          ) : (
            <div className="space-y-4">
              <p className="text-sm text-zinc-400">
                {t('profile.totp_scan')}
              </p>
              <div className="flex justify-center">
                {totpQr ? (
                  <img src={totpQr} alt={t('profile.totp_qr_alt')} className="rounded-lg w-44 h-44" />
                ) : (
                  <div className="w-44 h-44 rounded-lg bg-zinc-100 dark:bg-zinc-800 flex items-center justify-center text-zinc-500 text-xs">
                    {t('profile.totp_generating')}
                  </div>
                )}
              </div>
              <div className="flex items-center gap-2 bg-zinc-100 dark:bg-zinc-800 rounded-lg px-3 py-2">
                <code className="flex-1 text-xs text-zinc-700 dark:text-zinc-300 font-mono break-all">
                  {showSecret ? totpSetup.secret : '•'.repeat(totpSetup.secret.length)}
                </code>
                <button type="button" onClick={() => setShowSecret(!showSecret)} className="text-zinc-500 hover:text-zinc-300 p-1">
                  {showSecret ? <EyeOff size={13} /> : <Eye size={13} />}
                </button>
                <button type="button" onClick={copySecret} className={`p-1 ${copied ? 'text-emerald-400' : 'text-zinc-500 hover:text-zinc-300'}`}>
                  {copied ? <CheckCircle size={13} /> : <Copy size={13} />}
                </button>
              </div>
              <div>
                <label htmlFor="profile-totp-code" className="label">{t('profile.totp_enter_code')}</label>
                <input id="profile-totp-code" type="text" inputMode="numeric" maxLength={6} value={totpCode}
                  onChange={(e) => setTotpCode(e.target.value.replace(/\D/g, ''))}
                  className="input text-center text-xl tracking-[0.5em] font-mono" placeholder="000000" />
              </div>
              {totpError && <p className="text-sm text-red-400">{totpError}</p>}
              <div className="flex gap-3">
                <button type="button" onClick={() => { setTotpSetup(null); setTotpCode('') }} className="btn-secondary flex-1">{t('2fa.cancel')}</button>
                <button type="button" onClick={confirmTotp} disabled={totpLoading || totpCode.length < 6} className="btn-primary flex-1">
                  {totpLoading ? t('profile.totp_confirming') : t('profile.totp_confirm')}
                </button>
              </div>
            </div>
          )}
          {totpError && !totpSetup && <p className="text-sm text-red-400 mt-2">{totpError}</p>}
        </div>

        {/* Passkey */}
        <div className="card p-5">
          <h2 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300 mb-4 flex items-center gap-2">
            <Fingerprint size={15} className="text-zinc-500" /> {t('profile.passkey_title')}
          </h2>

          {user?.passkeyCredentials && user.passkeyCredentials.length > 0 && (
            <ul className="space-y-2 mb-4">
              {user.passkeyCredentials.map((cred) => (
                <li key={cred.id} className="flex items-center justify-between bg-zinc-100 dark:bg-zinc-800 rounded-lg px-4 py-2.5">
                  <div>
                    <p className="text-sm text-zinc-800 dark:text-zinc-200">{cred.name ?? t('profile.passkey')}</p>
                    <p className="text-xs text-zinc-500">{t('profile.totp_added')} {new Date(cred.created_at * 1000).toLocaleDateString()}</p>
                  </div>
                  <button type="button" onClick={() => askRemoval('passkey', cred.id)} className="btn-ghost p-1.5 text-red-400">
                    <Trash2 size={14} />
                  </button>
                </li>
              ))}
            </ul>
          )}

          <button type="button" onClick={registerPasskey} disabled={passkeyLoading} className="btn-secondary gap-2">
            <Plus size={14} /> {passkeyLoading ? t('profile.passkey_waiting') : t('profile.passkey_add')}
          </button>
          {passkeyError && <p className="text-sm text-red-400 mt-2">{passkeyError}</p>}
        </div>
      </div>

      {removal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
          <form onSubmit={confirmRemoval} className="card w-full max-w-sm p-6 shadow-2xl space-y-4">
            <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">
              {t(removal.kind === 'totp' ? 'profile.confirm_delete_totp' : 'profile.confirm_delete_passkey')}
            </h2>
            <p className="text-sm text-zinc-500">{t('profile.confirm_remove_desc')}</p>
            <div>
              <label htmlFor="removal-password" className="label">{t('profile.current_password')}</label>
              {/* biome-ignore lint/a11y/noAutofocus: focus moves into the dialog that just opened */}
              <input id="removal-password" type="password" className="input" value={removalPassword} autoFocus required
                autoComplete="current-password" onChange={(e) => setRemovalPassword(e.target.value)} />
            </div>
            {removalError && <p className="text-sm text-red-400">{removalError}</p>}
            <div className="flex gap-3">
              <button type="button" onClick={() => setRemoval(null)} className="btn-secondary flex-1">{t('2fa.cancel')}</button>
              <button type="submit" disabled={removalLoading || !removalPassword} className="btn-danger flex-1">
                {removalLoading ? t('profile.removing') : t('profile.remove')}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  )
}
