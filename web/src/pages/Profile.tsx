import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import {
  ArrowLeft,
  Shield,
  Key,
  Smartphone,
  Trash2,
  Plus,
  Eye,
  EyeOff,
  Copy,
  CheckCircle,
  Fingerprint,
} from 'lucide-react'
import QRCode from 'qrcode'
import { startRegistration } from '@simplewebauthn/browser'
import { profileApi } from '../lib/api'
import { useLocale } from '../hooks/useLocale'
import Logo from '../components/Logo'
import RunSettingsCard from '../components/RunSettingsCard'
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
    profileApi
      .me()
      .then(setUser)
      .finally(() => setLoading(false))
  }, [])

  // Generate QR code data URL when TOTP URI is available
  useEffect(() => {
    if (!totpSetup?.uri) {
      setTotpQr(null)
      return
    }
    QRCode.toDataURL(totpSetup.uri, { width: 176, margin: 1, color: { dark: '#1c1815', light: '#ffffff' } })
      .then(setTotpQr)
      .catch(() => setTotpQr(null))
  }, [totpSetup?.uri])

  async function savePassword(e: React.FormEvent) {
    e.preventDefault()
    if (pwForm.newPassword !== pwForm.confirm) {
      setPwError(t('auth.pw_mismatch'))
      return
    }
    if (pwForm.newPassword.length < 8) {
      setPwError(t('auth.pw_min_error'))
      return
    }
    setPwError('')
    setPwSuccess('')
    setPwLoading(true)
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
    setTotpLoading(true)
    setTotpError('')
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
    setTotpError('')
    setTotpLoading(true)
    try {
      await profileApi.confirmTotp({ code: totpCode })
      setTotpSetup(null)
      setTotpCode('')
      const updated = await profileApi.me()
      setUser(updated)
    } catch (err) {
      setTotpError(err instanceof Error ? err.message : t('errors.invalid_code'))
    } finally {
      setTotpLoading(false)
    }
  }

  function askRemoval(kind: 'totp' | 'passkey', id: string) {
    setRemoval({ kind, id })
    setRemovalPassword('')
    setRemovalError('')
  }

  async function confirmRemoval(e: React.FormEvent) {
    e.preventDefault()
    if (!removal) return
    setRemovalError('')
    setRemovalLoading(true)
    try {
      if (removal.kind === 'totp') await profileApi.deleteTotp(removal.id, removalPassword)
      else await profileApi.deletePasskey(removal.id, removalPassword)
      setRemoval(null)
      setRemovalPassword('')
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
    setPasskeyLoading(true)
    setPasskeyError('')
    try {
      const options = await profileApi.passkeyRegisterOptions()
      const result = await startRegistration({
        optionsJSON: options as unknown as Parameters<typeof startRegistration>[0]['optionsJSON'],
      })
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
      <div className="min-h-screen bg-ink-50 flex items-center justify-center text-ink-500 text-body">
        {t('common.loading')}
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-ink-50">
      {/* Header */}
      <header className="px-6 py-3 border-b border-ink-200 flex items-center gap-2.5 bg-ink-0">
        <Logo size="sm" />
        <span className="text-body-strong text-ink-900">{t('app.name')}</span>
        <div className="flex-1" />
        <Link to="/query" className="btn-ghost btn-sm gap-1.5">
          <ArrowLeft size={14} /> {t('profile.back_to_query')}
        </Link>
      </header>

      <div className="max-w-2xl mx-auto px-6 py-8 flex flex-col gap-8">
        <h1 className="text-display text-ink-950">{t('profile.title')}</h1>

        {/* Account info */}
        <div className="card p-5">
          <h2 className="text-heading text-ink-900 mb-4 flex items-center gap-2">
            <Shield size={15} className="text-ink-400" /> {t('profile.account')}
          </h2>
          <div className="flex flex-col gap-2 text-body">
            <div className="flex items-center justify-between">
              <span className="text-ink-500">{t('auth.name')}</span>
              <span className="text-ink-900">{user?.name}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-ink-500">{t('auth.email')}</span>
              <span className="text-ink-900">{user?.email}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-ink-500">{t('profile.role')}</span>
              <span className={`badge ${user?.role === 'admin' ? 'badge-brand' : 'badge-zinc'}`}>{user?.role}</span>
            </div>
          </div>
        </div>

        {/* Change password */}
        <div className="card p-5">
          <h2 className="text-heading text-ink-900 mb-4 flex items-center gap-2">
            <Key size={15} className="text-ink-400" /> {t('profile.change_password')}
          </h2>
          <form onSubmit={savePassword} className="space-y-4">
            <div>
              <label htmlFor="profile-current-password" className="label">
                {t('profile.current_password')}
              </label>
              <input
                id="profile-current-password"
                type="password"
                className="input"
                value={pwForm.currentPassword}
                onChange={(e) => setPwForm({ ...pwForm, currentPassword: e.target.value })}
                required
              />
            </div>
            <div>
              <label htmlFor="profile-new-password" className="label">
                {t('profile.new_password')}
              </label>
              <input
                id="profile-new-password"
                type="password"
                className="input"
                value={pwForm.newPassword}
                onChange={(e) => setPwForm({ ...pwForm, newPassword: e.target.value })}
                required
                placeholder={t('auth.pw_min')}
              />
            </div>
            <div>
              <label htmlFor="profile-confirm-password" className="label">
                {t('profile.confirm_new_password')}
              </label>
              <input
                id="profile-confirm-password"
                type="password"
                className="input"
                value={pwForm.confirm}
                onChange={(e) => setPwForm({ ...pwForm, confirm: e.target.value })}
                required
              />
            </div>
            {pwError && <p className="text-body text-danger-600">{pwError}</p>}
            {pwSuccess && <p className="text-body text-success-600">{pwSuccess}</p>}
            <button type="submit" className="btn-primary" disabled={pwLoading}>
              {pwLoading ? t('profile.saving') : t('profile.update_password')}
            </button>
          </form>
        </div>

        {/* TOTP */}
        <div className="card p-5">
          <h2 className="text-heading text-ink-900 mb-4 flex items-center gap-2">
            <Smartphone size={15} className="text-ink-400" /> {t('profile.totp_title')}
          </h2>

          {user?.totpCredentials && user.totpCredentials.length > 0 && (
            <ul className="space-y-2 mb-4">
              {user.totpCredentials.map((cred) => (
                <li key={cred.id} className="flex items-center justify-between bg-ink-100 rounded-lg px-4 py-2.5">
                  <div>
                    <p className="text-body-strong text-ink-900">{cred.name}</p>
                    <p className="text-caption text-ink-500 tnum">
                      {t('profile.totp_added')} {new Date(cred.created_at * 1000).toLocaleDateString()}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => askRemoval('totp', cred.id)}
                    className="btn-ghost p-1.5 text-danger-600"
                  >
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
              <p className="text-body text-ink-500">{t('profile.totp_scan')}</p>
              <div className="flex justify-center">
                {totpQr ? (
                  <img src={totpQr} alt={t('profile.totp_qr_alt')} className="rounded-lg w-44 h-44" />
                ) : (
                  <div className="w-44 h-44 rounded-lg bg-ink-100 flex items-center justify-center text-ink-500 text-caption">
                    {t('profile.totp_generating')}
                  </div>
                )}
              </div>
              <div className="flex items-center gap-2 bg-ink-100 rounded-lg px-3 py-2">
                <code className="flex-1 text-caption text-ink-700 font-mono break-all tnum">
                  {showSecret ? totpSetup.secret : '•'.repeat(totpSetup.secret.length)}
                </code>
                <button
                  type="button"
                  onClick={() => setShowSecret(!showSecret)}
                  className="text-ink-400 hover:text-ink-700 p-1 transition-colors duration-(--duration-base)"
                >
                  {showSecret ? <EyeOff size={13} /> : <Eye size={13} />}
                </button>
                <button
                  type="button"
                  onClick={copySecret}
                  className={`p-1 transition-colors duration-(--duration-base) ${copied ? 'text-success-600' : 'text-ink-400 hover:text-ink-700'}`}
                >
                  {copied ? <CheckCircle size={13} /> : <Copy size={13} />}
                </button>
              </div>
              <div>
                <label htmlFor="profile-totp-code" className="label">
                  {t('profile.totp_enter_code')}
                </label>
                <input
                  id="profile-totp-code"
                  type="text"
                  inputMode="numeric"
                  maxLength={6}
                  value={totpCode}
                  onChange={(e) => setTotpCode(e.target.value.replace(/\D/g, ''))}
                  className="input text-center text-xl tracking-[0.5em] font-mono"
                  placeholder="000000"
                />
              </div>
              {totpError && <p className="text-body text-danger-600">{totpError}</p>}
              <div className="flex gap-3">
                <button
                  type="button"
                  onClick={() => {
                    setTotpSetup(null)
                    setTotpCode('')
                  }}
                  className="btn-secondary flex-1"
                >
                  {t('2fa.cancel')}
                </button>
                <button
                  type="button"
                  onClick={confirmTotp}
                  disabled={totpLoading || totpCode.length < 6}
                  className="btn-primary flex-1"
                >
                  {totpLoading ? t('profile.totp_confirming') : t('profile.totp_confirm')}
                </button>
              </div>
            </div>
          )}
          {totpError && !totpSetup && <p className="text-body text-danger-600 mt-2">{totpError}</p>}
        </div>

        {/* Passkey */}
        <div className="card p-5">
          <h2 className="text-heading text-ink-900 mb-4 flex items-center gap-2">
            <Fingerprint size={15} className="text-ink-400" /> {t('profile.passkey_title')}
          </h2>

          {user?.passkeyCredentials && user.passkeyCredentials.length > 0 && (
            <ul className="space-y-2 mb-4">
              {user.passkeyCredentials.map((cred) => (
                <li key={cred.id} className="flex items-center justify-between bg-ink-100 rounded-lg px-4 py-2.5">
                  <div>
                    <p className="text-body-strong text-ink-900">{cred.name ?? t('profile.passkey')}</p>
                    <p className="text-caption text-ink-500 tnum">
                      {t('profile.totp_added')} {new Date(cred.created_at * 1000).toLocaleDateString()}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => askRemoval('passkey', cred.id)}
                    className="btn-ghost p-1.5 text-danger-600"
                  >
                    <Trash2 size={14} />
                  </button>
                </li>
              ))}
            </ul>
          )}

          <button type="button" onClick={registerPasskey} disabled={passkeyLoading} className="btn-secondary gap-2">
            <Plus size={14} /> {passkeyLoading ? t('profile.passkey_waiting') : t('profile.passkey_add')}
          </button>
          {passkeyError && <p className="text-body text-danger-600 mt-2">{passkeyError}</p>}
        </div>

        {/* Saved query runs */}
        <RunSettingsCard />
      </div>

      {removal && (
        <div className="fixed inset-0 z-(--z-modal) flex items-center justify-center p-4 bg-ink-950/50 backdrop-blur-sm animate-overlay-enter">
          <form onSubmit={confirmRemoval} className="card w-full max-w-sm p-6 shadow-lg space-y-4 animate-modal-enter">
            <h2 className="text-heading text-ink-900">
              {t(removal.kind === 'totp' ? 'profile.confirm_delete_totp' : 'profile.confirm_delete_passkey')}
            </h2>
            <p className="text-body text-ink-500">{t('profile.confirm_remove_desc')}</p>
            <div>
              <label htmlFor="removal-password" className="label">
                {t('profile.current_password')}
              </label>
              <input
                id="removal-password"
                type="password"
                className="input"
                value={removalPassword}
                // biome-ignore lint/a11y/noAutofocus: focus moves into the dialog that just opened
                autoFocus
                required
                autoComplete="current-password"
                onChange={(e) => setRemovalPassword(e.target.value)}
              />
            </div>
            {removalError && <p className="text-body text-danger-600">{removalError}</p>}
            <div className="flex gap-3">
              <button type="button" onClick={() => setRemoval(null)} className="btn-secondary flex-1">
                {t('2fa.cancel')}
              </button>
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
