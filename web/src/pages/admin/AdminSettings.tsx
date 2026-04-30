import { useState, useEffect } from 'react'
import { Save, Loader2 } from 'lucide-react'
import { adminApi } from '../../lib/api'

type Settings = Record<string, string>

export default function AdminSettings() {
  const [settings, setSettings] = useState<Settings>({})
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    adminApi.getSettings().then(setSettings).finally(() => setLoading(false))
  }, [])

  async function save() {
    setSaving(true); setError(''); setSaved(false)
    try {
      await adminApi.updateSettings(settings)
      setSaved(true)
      setTimeout(() => setSaved(false), 3000)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save')
    } finally {
      setSaving(false)
    }
  }

  const set = (key: string, value: string) => setSettings((s) => ({ ...s, [key]: value }))
  const toggle = (key: string) => set(key, settings[key] === 'true' ? 'false' : 'true')

  if (loading) return <div className="p-6 text-sm text-zinc-500">Loading…</div>

  return (
    <div className="p-4 sm:p-6 max-w-2xl">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-lg font-semibold text-zinc-100">Settings</h1>
        <button onClick={save} disabled={saving} className="btn-primary gap-2">
          {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
          {saved ? 'Saved!' : 'Save changes'}
        </button>
      </div>

      {error && <p className="text-sm text-red-400 mb-4">{error}</p>}

      <div className="space-y-6">
        {/* General */}
        <div className="card p-5 space-y-4">
          <h2 className="text-sm font-semibold text-zinc-400 uppercase tracking-wider">General</h2>
          <div>
            <label className="label">App name</label>
            <input type="text" className="input" value={settings['app_name'] ?? 'D1 Studio'}
              onChange={(e) => set('app_name', e.target.value)} />
          </div>
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-zinc-200">Registration open</p>
              <p className="text-xs text-zinc-500">Allow new users to register</p>
            </div>
            <button onClick={() => toggle('registration_enabled')}
              className={`relative w-11 h-6 rounded-full transition-colors ${settings['registration_enabled'] === 'true' ? 'bg-blue-600' : 'bg-zinc-700'}`}>
              <span className={`absolute top-1 w-4 h-4 bg-white rounded-full transition-transform ${settings['registration_enabled'] === 'true' ? 'translate-x-6' : 'translate-x-1'}`} />
            </button>
          </div>
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-zinc-200">Require email verification</p>
              <p className="text-xs text-zinc-500">Users must verify before logging in</p>
            </div>
            <button onClick={() => toggle('require_email_verification')}
              className={`relative w-11 h-6 rounded-full transition-colors ${settings['require_email_verification'] !== 'false' ? 'bg-blue-600' : 'bg-zinc-700'}`}>
              <span className={`absolute top-1 w-4 h-4 bg-white rounded-full transition-transform ${settings['require_email_verification'] !== 'false' ? 'translate-x-6' : 'translate-x-1'}`} />
            </button>
          </div>
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-zinc-200">Enforce 2FA for all users</p>
              <p className="text-xs text-zinc-500">Require 2FA even if not individually set</p>
            </div>
            <button onClick={() => toggle('enforce_2fa')}
              className={`relative w-11 h-6 rounded-full transition-colors ${settings['enforce_2fa'] === 'true' ? 'bg-blue-600' : 'bg-zinc-700'}`}>
              <span className={`absolute top-1 w-4 h-4 bg-white rounded-full transition-transform ${settings['enforce_2fa'] === 'true' ? 'translate-x-6' : 'translate-x-1'}`} />
            </button>
          </div>
        </div>

        {/* Email */}
        <div className="card p-5 space-y-4">
          <h2 className="text-sm font-semibold text-zinc-400 uppercase tracking-wider">Email Provider</h2>
          <div>
            <label className="label">Provider</label>
            <select className="input" value={settings['email_provider'] ?? 'resend'}
              onChange={(e) => set('email_provider', e.target.value)}>
              <option value="resend">Resend</option>
              <option value="smtp">Custom SMTP (via MailChannels)</option>
            </select>
          </div>
          <div>
            <label className="label">From address</label>
            <input type="email" className="input" value={settings['smtp_from'] ?? ''}
              onChange={(e) => set('smtp_from', e.target.value)} placeholder="noreply@yourdomain.com" />
          </div>

          {settings['email_provider'] === 'resend' ? (
            <div>
              <label className="label">Resend API key</label>
              <input type="password" className="input font-mono" value={settings['resend_api_key'] ?? ''}
                onChange={(e) => set('resend_api_key', e.target.value)}
                placeholder="re_xxxxxxxxxxxx" autoComplete="off" />
            </div>
          ) : (
            <div className="space-y-3">
              <div className="grid grid-cols-3 gap-3">
                <div className="col-span-2">
                  <label className="label">SMTP host</label>
                  <input type="text" className="input" value={settings['smtp_host'] ?? ''}
                    onChange={(e) => set('smtp_host', e.target.value)} placeholder="smtp.mailchannels.net" />
                </div>
                <div>
                  <label className="label">Port</label>
                  <input type="number" className="input" value={settings['smtp_port'] ?? '587'}
                    onChange={(e) => set('smtp_port', e.target.value)} />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="label">Username</label>
                  <input type="text" className="input" value={settings['smtp_user'] ?? ''}
                    onChange={(e) => set('smtp_user', e.target.value)} autoComplete="off" />
                </div>
                <div>
                  <label className="label">Password</label>
                  <input type="password" className="input" value={settings['smtp_pass'] ?? ''}
                    onChange={(e) => set('smtp_pass', e.target.value)} autoComplete="off" />
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
