import { useState, useEffect } from 'react'
import { Save, Loader2, Send, Database } from 'lucide-react'
import { adminApi, adminSetupApi, ApiError } from '../../lib/api'
import { adminSetupErrorKey } from '../../lib/setup'
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

type Translate = (key: string, vars?: Record<string, string | number>) => string

// Stateless presentation for the database-maintenance card, split out so its three result
// branches (up-to-date / upgraded / failed) and the loading button can be asserted without a
// browser via renderToStaticMarkup.
interface AdminSetupCardProps {
  t: Translate
  // null = not run yet (no result shown); otherwise a success — [] means up to date,
  // non-empty lists the upgrade items.
  upgraded: string[] | null
  error: string
  running: boolean
  onRun: () => void
}

export function AdminSetupCard({ t, upgraded, error, running, onRun }: AdminSetupCardProps) {
  return (
    <div className="card p-5 space-y-4">
      <h2 className="text-micro uppercase text-ink-500">{t('admin_setup.title')}</h2>
      <p className="text-body text-ink-700">{t('admin_setup.desc')}</p>

      {upgraded !== null && (
        <div role="status" className="space-y-3">
          {upgraded.length > 0 ? (
            <>
              <p className="text-body text-success-600">{t('admin_setup.upgraded_title')}</p>
              <ul className="text-body text-ink-700 list-disc list-inside space-y-1">
                {upgraded.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </>
          ) : (
            <p className="text-body text-success-600">{t('admin_setup.up_to_date')}</p>
          )}
        </div>
      )}

      {error && (
        <p role="alert" className="text-body text-danger-600">
          {error}
        </p>
      )}

      <div>
        <button type="button" onClick={onRun} disabled={running} className="btn-primary gap-2">
          {running ? <Loader2 size={14} className="animate-spin" /> : <Database size={14} />}
          {running ? t('admin_setup.running') : t('admin_setup.run')}
        </button>
      </div>
    </div>
  )
}

export default function AdminSettings() {
  const { t } = useLocale()
  const [settings, setSettings] = useState<Settings>({})
  const [emailProvider, setEmailProvider] = useState<EmailProvider>('none')
  const [smtp, setSmtp] = useState<SmtpConfig>(DEFAULT_SMTP)
  const [resend, setResend] = useState<ResendConfig>(DEFAULT_RESEND)
  const [smtpHasSecret, setSmtpHasSecret] = useState(false)
  // Admin asked to remove the stored SMTP password (e.g. the server no longer needs auth)
  const [smtpClearSecret, setSmtpClearSecret] = useState(false)
  const [resendHasSecret, setResendHasSecret] = useState(false)
  const [resendClearSecret, setResendClearSecret] = useState(false)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState('')

  // Test email state
  const [testEmailTo, setTestEmailTo] = useState('')
  const [testEmailLoading, setTestEmailLoading] = useState(false)
  const [testEmailMsg, setTestEmailMsg] = useState('')
  const [testEmailError, setTestEmailError] = useState('')

  // Database maintenance state
  const [upgradeUpgraded, setUpgradeUpgraded] = useState<string[] | null>(null)
  const [upgradeRunning, setUpgradeRunning] = useState(false)
  const [upgradeError, setUpgradeError] = useState('')

  useEffect(() => {
    adminApi
      .getSettings()
      .then((cfg) => {
        setSettings(cfg)
        const provider = cfg.email_provider
        setEmailProvider(provider === 'smtp' || provider === 'resend' ? provider : 'none')
        if (cfg.smtp_config) {
          try {
            const parsed = JSON.parse(cfg.smtp_config)
            setSmtpHasSecret(Boolean(parsed.password))
            setSmtp({ ...DEFAULT_SMTP, ...parsed, password: '' })
          } catch {
            /* ignore */
          }
        }
        if (cfg.resend_config) {
          try {
            const parsed = JSON.parse(cfg.resend_config)
            setResendHasSecret(Boolean(parsed.api_key))
            setResend({ ...DEFAULT_RESEND, ...parsed, api_key: '' })
          } catch {
            /* ignore */
          }
        }
      })
      .finally(() => setLoading(false))
  }, [])

  const set = (key: string, value: string) => setSettings((s) => ({ ...s, [key]: value }))
  const toggle = (key: string) => set(key, settings[key] === 'true' ? 'false' : 'true')
  const setSmtpField = (key: keyof SmtpConfig, val: string) => setSmtp((prev) => ({ ...prev, [key]: val }))
  const setResendField = (key: keyof ResendConfig, val: string) => setResend((prev) => ({ ...prev, [key]: val }))

  async function save() {
    setSaving(true)
    setError('')
    setSaved(false)
    try {
      // The loaded smtp/resend blobs contain masked secrets; only send a config the admin is editing.
      const { smtp_config: _smtp, resend_config: _resend, ...rest } = settings
      const payload: Record<string, string> = { ...rest, email_provider: emailProvider }

      if (emailProvider === 'smtp') {
        const { password, ...smtpRest } = smtp
        payload.smtp_config = JSON.stringify({
          ...smtpRest,
          port: Number(smtp.port) || 587,
          // Omitted = keep the stored password, '' = clear it
          ...(password ? { password } : smtpClearSecret ? { password: '' } : {}),
        })
      }
      if (emailProvider === 'resend') {
        const { api_key, ...resendRest } = resend
        payload.resend_config = JSON.stringify({
          ...resendRest,
          // Omitted = keep the stored key, '' = clear it
          ...(api_key ? { api_key } : resendClearSecret ? { api_key: '' } : {}),
        })
      }

      await adminApi.updateSettings(payload)
      if (emailProvider === 'smtp' && (smtp.password || smtpClearSecret)) {
        setSmtpHasSecret(Boolean(smtp.password))
        setSmtpClearSecret(false)
      }
      if (emailProvider === 'resend' && (resend.api_key || resendClearSecret)) {
        setResendHasSecret(Boolean(resend.api_key))
        setResendClearSecret(false)
      }
      setSaved(true)
      setTimeout(() => setSaved(false), 3000)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('errors.save_failed'))
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
    } catch (e) {
      setTestEmailError((e instanceof Error && e.message) || t('admin_settings.test_email_failed'))
    } finally {
      setTestEmailLoading(false)
    }
  }

  async function handleUpgrade() {
    setUpgradeRunning(true)
    setUpgradeError('')
    setUpgradeUpgraded(null)
    try {
      const res = await adminSetupApi.run()
      setUpgradeUpgraded(res.upgraded ?? [])
    } catch (err) {
      if (err instanceof ApiError) {
        const key = adminSetupErrorKey(err.status)
        setUpgradeError(key ? t(key) : err.message || t('errors.generic'))
      } else {
        setUpgradeError(t('errors.generic'))
      }
    } finally {
      setUpgradeRunning(false)
    }
  }

  if (loading) return <div className="p-6 text-body text-ink-500">{t('admin_settings.loading')}</div>

  // The setup page is enabled unless explicitly disabled; new installs default to enabled ('1').
  const setupPageEnabled = (settings.setup_page_enabled ?? '1') !== '0'

  return (
    <div className="p-4 sm:p-6 max-w-5xl flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <h1 className="text-title text-ink-950">{t('admin.settings')}</h1>
        <button type="button" onClick={save} disabled={saving} className="btn-primary gap-2">
          {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
          {saved ? t('admin_settings.saved') : t('admin_settings.save_changes')}
        </button>
      </div>

      {error && <p className="-mt-3 text-body text-danger-600">{error}</p>}

      <div className="flex flex-col gap-6">
        {/* General */}
        <div className="card p-5 space-y-4">
          <h2 className="text-micro uppercase text-ink-500">{t('admin_settings.general')}</h2>
          <div>
            <label htmlFor="settings-app-name" className="label">
              {t('admin_settings.app_name')}
            </label>
            <input
              id="settings-app-name"
              type="text"
              className="input"
              value={settings.app_name ?? 'Zeta'}
              onChange={(e) => set('app_name', e.target.value)}
            />
          </div>
          <div className="flex items-center justify-between">
            <div>
              <p className="text-body-strong text-ink-900">{t('admin_settings.registration_open')}</p>
              <p className="text-caption text-ink-500">{t('admin_settings.registration_desc')}</p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={settings.registration_enabled === 'true'}
              onClick={() => toggle('registration_enabled')}
              className="toggle-track"
            >
              <span className="toggle-thumb" />
            </button>
          </div>
          <div className="flex items-center justify-between">
            <div>
              <p className="text-body-strong text-ink-900">{t('admin_settings.require_verification')}</p>
              <p className="text-caption text-ink-500">{t('admin_settings.require_verification_desc')}</p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={settings.require_email_verification !== 'false'}
              onClick={() => toggle('require_email_verification')}
              className="toggle-track"
            >
              <span className="toggle-thumb" />
            </button>
          </div>
          <div className="flex items-center justify-between">
            <div>
              <p className="text-body-strong text-ink-900">{t('admin_settings.enforce_2fa')}</p>
              <p className="text-caption text-ink-500">{t('admin_settings.enforce_2fa_desc')}</p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={settings.enforce_2fa === 'true'}
              onClick={() => toggle('enforce_2fa')}
              className="toggle-track"
            >
              <span className="toggle-thumb" />
            </button>
          </div>
          <div className="flex items-center justify-between">
            <div>
              <p className="text-body-strong text-ink-900">{t('admin_settings.setup_page')}</p>
              <p className="text-caption text-ink-500">{t('admin_settings.setup_page_desc')}</p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={setupPageEnabled}
              aria-label={t('admin_settings.setup_page')}
              onClick={() => set('setup_page_enabled', setupPageEnabled ? '0' : '1')}
              className="toggle-track"
            >
              <span className="toggle-thumb" />
            </button>
          </div>
        </div>

        {/* Database maintenance */}
        <AdminSetupCard
          t={t}
          upgraded={upgradeUpgraded}
          error={upgradeError}
          running={upgradeRunning}
          onRun={() => void handleUpgrade()}
        />

        {/* Saved query runs */}
        <div className="card p-5 space-y-4">
          <h2 className="text-micro uppercase text-ink-500">{t('admin_settings.saved_runs')}</h2>
          <div>
            <label htmlFor="settings-run-limit" className="label">
              {t('admin_settings.run_limit')}
            </label>
            <input
              id="settings-run-limit"
              type="number"
              min={1}
              max={1000}
              step={1}
              className="input"
              value={settings.notebook_run_limit ?? '100'}
              onChange={(e) => set('notebook_run_limit', e.target.value)}
            />
            <p className="text-caption text-ink-500 mt-1 tnum">{t('admin_settings.run_limit_desc')}</p>
          </div>
          <div>
            <label htmlFor="settings-run-quota" className="label">
              {t('admin_settings.run_quota')}
            </label>
            <input
              id="settings-run-quota"
              type="number"
              min={1}
              max={1024}
              step={1}
              className="input"
              value={settings.run_storage_quota_mb ?? '50'}
              onChange={(e) => set('run_storage_quota_mb', e.target.value)}
            />
            <p className="text-caption text-ink-500 mt-1 tnum">{t('admin_settings.run_quota_desc')}</p>
          </div>
        </div>

        {/* Email */}
        <div className="card p-5 space-y-4">
          <h2 className="text-micro uppercase text-ink-500">{t('admin_settings.email_provider')}</h2>

          <div className="flex gap-4">
            {(['none', 'smtp', 'resend'] as EmailProvider[]).map((p) => (
              <label key={p} className="flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="email_provider"
                  value={p}
                  checked={emailProvider === p}
                  onChange={() => setEmailProvider(p)}
                  className="accent-(--color-brand-600)"
                />
                <span className="text-body-strong text-ink-900">
                  {p === 'none' ? t('admin_settings.provider_none') : p === 'smtp' ? 'SMTP' : 'Resend'}
                </span>
              </label>
            ))}
          </div>

          {emailProvider === 'smtp' && (
            <div className="space-y-3 pt-2 border-t border-ink-200">
              <div className="grid grid-cols-3 gap-3">
                <div className="col-span-2">
                  <label htmlFor="smtp-host" className="label">
                    {t('admin_settings.smtp_host')}
                  </label>
                  <input
                    id="smtp-host"
                    type="text"
                    className="input"
                    value={smtp.host}
                    onChange={(e) => setSmtpField('host', e.target.value)}
                    placeholder="smtp.example.com"
                  />
                </div>
                <div>
                  <label htmlFor="smtp-port" className="label">
                    {t('admin_settings.smtp_port')}
                  </label>
                  <input
                    id="smtp-port"
                    type="number"
                    className="input"
                    value={smtp.port}
                    onChange={(e) => setSmtpField('port', e.target.value)}
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label htmlFor="smtp-username" className="label">
                    {t('admin_settings.smtp_username')}
                  </label>
                  <input
                    id="smtp-username"
                    type="text"
                    className="input"
                    value={smtp.username}
                    onChange={(e) => setSmtpField('username', e.target.value)}
                    autoComplete="off"
                  />
                </div>
                <div>
                  <label htmlFor="smtp-password" className="label">
                    {t('admin_settings.smtp_password')}
                  </label>
                  <input
                    id="smtp-password"
                    type="password"
                    className="input"
                    value={smtp.password}
                    onChange={(e) => {
                      setSmtpField('password', e.target.value)
                      if (e.target.value) setSmtpClearSecret(false)
                    }}
                    autoComplete="off"
                    placeholder={
                      smtpClearSecret
                        ? t('admin_settings.secret_will_clear')
                        : smtpHasSecret
                          ? t('admin_settings.keep_existing')
                          : ''
                    }
                  />
                  {smtpHasSecret && !smtpClearSecret && !smtp.password && (
                    <button
                      type="button"
                      onClick={() => setSmtpClearSecret(true)}
                      className="mt-1 text-caption text-ink-500 hover:text-danger-600 transition-colors duration-(--duration-base)"
                    >
                      {t('admin_settings.clear_secret')}
                    </button>
                  )}
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label htmlFor="smtp-from" className="label">
                    {t('admin_settings.from_address')}
                  </label>
                  <input
                    id="smtp-from"
                    type="email"
                    className="input"
                    value={smtp.from}
                    onChange={(e) => setSmtpField('from', e.target.value)}
                  />
                </div>
                <div>
                  <label htmlFor="smtp-from-name" className="label">
                    {t('admin_settings.from_name')}
                  </label>
                  <input
                    id="smtp-from-name"
                    type="text"
                    className="input"
                    value={smtp.from_name}
                    onChange={(e) => setSmtpField('from_name', e.target.value)}
                  />
                </div>
              </div>
            </div>
          )}

          {emailProvider === 'resend' && (
            <div className="space-y-3 pt-2 border-t border-ink-200">
              <div>
                <label htmlFor="resend-api-key" className="label">
                  {t('admin_settings.resend_api_key')}
                </label>
                <input
                  id="resend-api-key"
                  type="password"
                  className="input font-mono"
                  value={resend.api_key}
                  onChange={(e) => {
                    setResendField('api_key', e.target.value)
                    if (e.target.value) setResendClearSecret(false)
                  }}
                  placeholder={
                    resendClearSecret
                      ? t('admin_settings.secret_will_clear')
                      : resendHasSecret
                        ? t('admin_settings.keep_existing')
                        : 're_xxxxxxxxxxxx'
                  }
                  autoComplete="off"
                />
                {resendHasSecret && !resendClearSecret && !resend.api_key && (
                  <button
                    type="button"
                    onClick={() => setResendClearSecret(true)}
                    className="mt-1 text-caption text-ink-500 hover:text-danger-600 transition-colors duration-(--duration-base)"
                  >
                    {t('admin_settings.clear_secret')}
                  </button>
                )}
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label htmlFor="resend-from" className="label">
                    {t('admin_settings.from_address')}
                  </label>
                  <input
                    id="resend-from"
                    type="email"
                    className="input"
                    value={resend.from}
                    onChange={(e) => setResendField('from', e.target.value)}
                  />
                </div>
                <div>
                  <label htmlFor="resend-from-name" className="label">
                    {t('admin_settings.from_name')}
                  </label>
                  <input
                    id="resend-from-name"
                    type="text"
                    className="input"
                    value={resend.from_name}
                    onChange={(e) => setResendField('from_name', e.target.value)}
                  />
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Test Email */}
        {emailProvider !== 'none' && (
          <div className="card p-5 space-y-4">
            <h2 className="text-micro uppercase text-ink-500">{t('admin_settings.test_email')}</h2>
            <div>
              <label htmlFor="test-email-to" className="label">
                {t('admin_settings.test_email_address')}
              </label>
              <input
                id="test-email-to"
                type="email"
                className="input"
                value={testEmailTo}
                onChange={(e) => setTestEmailTo(e.target.value)}
                placeholder="user@example.com"
              />
            </div>
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={handleTestEmail}
                disabled={testEmailLoading || !testEmailTo}
                className="btn-primary gap-2"
              >
                {testEmailLoading ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
                {t('admin_settings.test_email')}
              </button>
              {testEmailMsg && <span className="text-body text-success-600">{testEmailMsg}</span>}
              {testEmailError && <span className="text-body text-danger-600">{testEmailError}</span>}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
