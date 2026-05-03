import { useState, useEffect } from 'react'
import { Save, Loader2 } from 'lucide-react'
import { adminApi } from '../../lib/api'
import { useLocale } from '../../hooks/useLocale'

type Settings = Record<string, string>

export default function AdminSettings() {
  const { t } = useLocale()
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

  if (loading) return <div className="p-6 text-sm text-zinc-500">{t('admin_settings.loading')}</div>

  return (
    <div className="p-4 sm:p-6 max-w-2xl">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">{t('admin.settings')}</h1>
        <button onClick={save} disabled={saving} className="btn-primary gap-2">
          {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
          {saved ? t('admin_settings.saved') : t('admin_settings.save_changes')}
        </button>
      </div>

      {error && <p className="text-sm text-red-400 mb-4">{error}</p>}

      <div className="space-y-6">
        {/* General */}
        <div className="card p-5 space-y-4">
          <h2 className="text-sm font-semibold text-zinc-400 uppercase tracking-wider">{t('admin_settings.general')}</h2>
          <div>
            <label className="label">{t('admin_settings.app_name')}</label>
            <input type="text" className="input" value={settings['app_name'] ?? 'Zeta'}
              onChange={(e) => set('app_name', e.target.value)} />
          </div>
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-zinc-700 dark:text-zinc-200">{t('admin_settings.registration_open')}</p>
              <p className="text-xs text-zinc-500">{t('admin_settings.registration_desc')}</p>
            </div>
            <button role="switch" aria-checked={settings['registration_enabled'] === 'true'} onClick={() => toggle('registration_enabled')}
              className="toggle-track">
              <span className="toggle-thumb" />
            </button>
          </div>
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-zinc-700 dark:text-zinc-200">{t('admin_settings.require_verification')}</p>
              <p className="text-xs text-zinc-500">{t('admin_settings.require_verification_desc')}</p>
            </div>
            <button role="switch" aria-checked={settings['require_email_verification'] !== 'false'} onClick={() => toggle('require_email_verification')}
              className="toggle-track">
              <span className="toggle-thumb" />
            </button>
          </div>
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-zinc-700 dark:text-zinc-200">{t('admin_settings.enforce_2fa')}</p>
              <p className="text-xs text-zinc-500">{t('admin_settings.enforce_2fa_desc')}</p>
            </div>
            <button role="switch" aria-checked={settings['enforce_2fa'] === 'true'} onClick={() => toggle('enforce_2fa')}
              className="toggle-track">
              <span className="toggle-thumb" />
            </button>
          </div>
        </div>

        {/* Email */}
        <div className="card p-5 space-y-4">
          <h2 className="text-sm font-semibold text-zinc-400 uppercase tracking-wider">{t('admin_settings.email_provider')}</h2>
          <div>
            <label className="label">{t('admin_settings.provider')}</label>
            <select className="input" value={settings['email_provider'] ?? 'resend'}
              onChange={(e) => set('email_provider', e.target.value)}>
              <option value="resend">Resend</option>
              <option value="smtp">Custom SMTP (via MailChannels)</option>
            </select>
          </div>
          <div>
            <label className="label">{t('admin_settings.from_address')}</label>
            <input type="email" className="input" value={settings['smtp_from'] ?? ''}
              onChange={(e) => set('smtp_from', e.target.value)} placeholder="noreply@yourdomain.com" />
          </div>

          {settings['email_provider'] === 'resend' ? (
            <div>
              <label className="label">{t('admin_settings.resend_api_key')}</label>
              <input type="password" className="input font-mono" value={settings['resend_api_key'] ?? ''}
                onChange={(e) => set('resend_api_key', e.target.value)}
                placeholder="re_xxxxxxxxxxxx" autoComplete="off" />
            </div>
          ) : (
            <div className="space-y-3">
              <div className="grid grid-cols-3 gap-3">
                <div className="col-span-2">
                  <label className="label">{t('admin_settings.smtp_host')}</label>
                  <input type="text" className="input" value={settings['smtp_host'] ?? ''}
                    onChange={(e) => set('smtp_host', e.target.value)} placeholder="smtp.mailchannels.net" />
                </div>
                <div>
                  <label className="label">{t('admin_settings.smtp_port')}</label>
                  <input type="number" className="input" value={settings['smtp_port'] ?? '587'}
                    onChange={(e) => set('smtp_port', e.target.value)} />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="label">{t('admin_settings.smtp_username')}</label>
                  <input type="text" className="input" value={settings['smtp_user'] ?? ''}
                    onChange={(e) => set('smtp_user', e.target.value)} autoComplete="off" />
                </div>
                <div>
                  <label className="label">{t('admin_settings.smtp_password')}</label>
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
