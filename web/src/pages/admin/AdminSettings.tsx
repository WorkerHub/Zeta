import { useState, useEffect } from 'react'
import { Save, Loader2, Send } from 'lucide-react'
import { adminApi } from '../../lib/api'
import { useLocale } from '../../hooks/useLocale'

type Settings = Record<string, string>

type EmailProvider = 'none' | 'smtp' | 'resend'

interface SmtpConfig {
  host: string
  port: string
  username: string
  password: string
  from: string
  from_name: string
}

interface ResendConfig {
  api_key: string
  from: string
  from_name: string
}

const DEFAULT_SMTP: SmtpConfig = { host: '', port: '587', username: '', password: '', from: '', from_name: '' }
const DEFAULT_RESEND: ResendConfig = { api_key: '', from: '', from_name: '' }

export default function AdminSettings() {
  const { t } = useLocale()
  const [settings, setSettings] = useState<Settings>({})
  const [emailProvider, setEmailProvider] = useState<EmailProvider>('none')
  const [smtp, setSmtp] = useState<SmtpConfig>(DEFAULT_SMTP)
  const [resend, setResend] = useState<ResendConfig>(DEFAULT_RESEND)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState('')

  // Test email state
  const [testEmailTo, setTestEmailTo] = useState('')
  const [testEmailLoading, setTestEmailLoading] = useState(false)
  const [testEmailMsg, setTestEmailMsg] = useState('')
  const [testEmailError, setTestEmailError] = useState('')

  useEffect(() => {
    adminApi.getSettings().then((cfg) => {
      setSettings(cfg)
      setEmailProvider((cfg['email_provider'] as EmailProvider) || 'none')
      if (cfg['smtp_config']) {
        try {
          const parsed = JSON.parse(cfg['smtp_config'])
          const hasPassword = parsed.password && parsed.password !== ''
          setSmtp({ ...DEFAULT_SMTP, ...parsed, password: '', _hasExisting: hasPassword } as any)
        } catch { /* ignore */ }
      }
      if (cfg['resend_config']) {
        try {
          const parsed = JSON.parse(cfg['resend_config'])
          const hasKey = parsed.api_key && parsed.api_key !== ''
          setResend({ ...DEFAULT_RESEND, ...parsed, api_key: '', _hasExisting: hasKey } as any)
        } catch { /* ignore */ }
      }
    }).finally(() => setLoading(false))
  }, [])

  const set = (key: string, value: string) => setSettings((s) => ({ ...s, [key]: value }))
  const toggle = (key: string) => set(key, settings[key] === 'true' ? 'false' : 'true')
  const setSmtpField = (key: keyof SmtpConfig, val: string) =>
    setSmtp((prev) => ({ ...prev, [key]: val }))
  const setResendField = (key: keyof ResendConfig, val: string) =>
    setResend((prev) => ({ ...prev, [key]: val }))

  async function save() {
    setSaving(true); setError(''); setSaved(false)
    try {
      const payload: Record<string, string> = { ...settings, email_provider: emailProvider }

      if (emailProvider === 'smtp') {
        const smtpPayload: Record<string, any> = { ...smtp, port: Number(smtp.port) || 587 }
        delete (smtpPayload as any)._hasExisting
        if (!smtpPayload.password) delete smtpPayload.password
        payload.smtp_config = JSON.stringify(smtpPayload)
      }
      if (emailProvider === 'resend') {
        const resendPayload: Record<string, any> = { ...resend }
        delete (resendPayload as any)._hasExisting
        if (!resendPayload.api_key) delete resendPayload.api_key
        payload.resend_config = JSON.stringify(resendPayload)
      }

      await adminApi.updateSettings(payload)
      setSaved(true)
      setTimeout(() => setSaved(false), 3000)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save')
    } finally {
      setSaving(false)
    }
  }

  async function handleTestEmail() {
    setTestEmailLoading(true)
    setTestEmailMsg('')
    setTestEmailError('')
    try {
      await adminApi.testEmail(testEmailTo)
      setTestEmailMsg(t('admin_settings.test_email_sent'))
      setTimeout(() => setTestEmailMsg(''), 4000)
    } catch (e: any) {
      setTestEmailError(e.message || t('admin_settings.test_email_failed'))
    } finally {
      setTestEmailLoading(false)
    }
  }

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

          <div className="flex gap-4">
            {(['none', 'smtp', 'resend'] as EmailProvider[]).map((p) => (
              <label key={p} className="flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="email_provider"
                  value={p}
                  checked={emailProvider === p}
                  onChange={() => setEmailProvider(p)}
                  className="accent-primary"
                />
                <span className="text-sm font-medium">
                  {p === 'none' ? t('admin_settings.provider_none') : p === 'smtp' ? 'SMTP' : 'Resend'}
                </span>
              </label>
            ))}
          </div>

          {emailProvider === 'smtp' && (
            <div className="space-y-3 pt-2 border-t border-zinc-200 dark:border-zinc-700">
              <div className="grid grid-cols-3 gap-3">
                <div className="col-span-2">
                  <label className="label">{t('admin_settings.smtp_host')}</label>
                  <input type="text" className="input" value={smtp.host}
                    onChange={(e) => setSmtpField('host', e.target.value)} placeholder="smtp.example.com" />
                </div>
                <div>
                  <label className="label">{t('admin_settings.smtp_port')}</label>
                  <input type="number" className="input" value={smtp.port}
                    onChange={(e) => setSmtpField('port', e.target.value)} />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="label">{t('admin_settings.smtp_username')}</label>
                  <input type="text" className="input" value={smtp.username}
                    onChange={(e) => setSmtpField('username', e.target.value)} autoComplete="off" />
                </div>
                <div>
                  <label className="label">{t('admin_settings.smtp_password')}</label>
                  <input type="password" className="input" value={smtp.password}
                    onChange={(e) => setSmtpField('password', e.target.value)} autoComplete="off"
                    placeholder={(smtp as any)._hasExisting ? 'Leave blank to keep existing' : ''} />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="label">{t('admin_settings.from_address')}</label>
                  <input type="email" className="input" value={smtp.from}
                    onChange={(e) => setSmtpField('from', e.target.value)} />
                </div>
                <div>
                  <label className="label">{t('admin_settings.from_name')}</label>
                  <input type="text" className="input" value={smtp.from_name}
                    onChange={(e) => setSmtpField('from_name', e.target.value)} />
                </div>
              </div>
            </div>
          )}

          {emailProvider === 'resend' && (
            <div className="space-y-3 pt-2 border-t border-zinc-200 dark:border-zinc-700">
              <div>
                <label className="label">{t('admin_settings.resend_api_key')}</label>
                <input type="password" className="input font-mono" value={resend.api_key}
                  onChange={(e) => setResendField('api_key', e.target.value)}
                  placeholder={(resend as any)._hasExisting ? 'Leave blank to keep existing' : 're_xxxxxxxxxxxx'}
                  autoComplete="off" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="label">{t('admin_settings.from_address')}</label>
                  <input type="email" className="input" value={resend.from}
                    onChange={(e) => setResendField('from', e.target.value)} />
                </div>
                <div>
                  <label className="label">{t('admin_settings.from_name')}</label>
                  <input type="text" className="input" value={resend.from_name}
                    onChange={(e) => setResendField('from_name', e.target.value)} />
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Test Email */}
        {emailProvider !== 'none' && (
          <div className="card p-5 space-y-4">
            <h2 className="text-sm font-semibold text-zinc-400 uppercase tracking-wider">{t('admin_settings.test_email')}</h2>
            <div>
              <label className="label">{t('admin_settings.test_email_address')}</label>
              <input type="email" className="input" value={testEmailTo}
                onChange={(e) => setTestEmailTo(e.target.value)}
                placeholder="user@example.com" />
            </div>
            <div className="flex items-center gap-3">
              <button type="button" onClick={handleTestEmail}
                disabled={testEmailLoading || !testEmailTo}
                className="btn-primary gap-2">
                {testEmailLoading ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
                {t('admin_settings.test_email')}
              </button>
              {testEmailMsg && <span className="text-sm text-green-500">{testEmailMsg}</span>}
              {testEmailError && <span className="text-sm text-red-400">{testEmailError}</span>}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
