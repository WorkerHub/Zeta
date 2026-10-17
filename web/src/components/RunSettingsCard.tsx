import { useCallback, useEffect, useState } from 'react'
import { History, Loader2 } from 'lucide-react'
import { profileApi } from '../lib/api'
import { formatBytes } from '../lib/format'
import { useLocale } from '../hooks/useLocale'
import type { RunSettings } from '../types'

// Profile card: how many runs per notebook the user keeps (at most the admin limit) and how much
// of their storage quota the saved results use
export default function RunSettingsCard() {
  const { t } = useLocale()
  const [settings, setSettings] = useState<RunSettings | null>(null)
  const [value, setValue] = useState('')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState('')

  const apply = useCallback((s: RunSettings) => {
    setSettings(s)
    setValue(s.run_limit === null ? '' : String(s.run_limit))
  }, [])

  useEffect(() => {
    profileApi
      .runSettings()
      .then(apply)
      .catch(() => setError(t('errors.load_run_settings_failed')))
  }, [t, apply])

  async function save(e: React.FormEvent) {
    e.preventDefault()
    if (!settings) return
    const trimmed = value.trim()
    const n = Number(trimmed)
    if (trimmed && (!Number.isInteger(n) || n < 1 || n > settings.admin_run_limit)) {
      setError(t('profile.run_limit_invalid', { max: settings.admin_run_limit }))
      return
    }
    setSaving(true)
    setError('')
    setSaved(false)
    try {
      apply(await profileApi.updateRunSettings({ run_limit: trimmed ? n : null }))
      setSaved(true)
      setTimeout(() => setSaved(false), 3000)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('errors.save_failed'))
    } finally {
      setSaving(false)
    }
  }

  const capped = settings !== null && settings.run_limit !== null && settings.run_limit > settings.admin_run_limit

  return (
    <div className="card p-5">
      <h2 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300 mb-4 flex items-center gap-2">
        <History size={15} className="text-zinc-500" /> {t('profile.run_title')}
      </h2>
      {!settings ? (
        error ? (
          <p className="text-sm text-red-400">{error}</p>
        ) : (
          <p className="text-sm text-zinc-500">{t('common.loading')}</p>
        )
      ) : (
        <form onSubmit={save} className="space-y-3">
          <div>
            <label htmlFor="profile-run-limit" className="label">
              {t('profile.run_limit')}
            </label>
            <div className="flex gap-2">
              <input
                id="profile-run-limit"
                type="number"
                min={1}
                max={settings.admin_run_limit}
                step={1}
                className="input"
                placeholder={t('profile.run_limit_placeholder', { n: settings.admin_run_limit })}
                value={value}
                onChange={(e) => setValue(e.target.value)}
              />
              <button type="submit" disabled={saving} className="btn-primary gap-2 shrink-0">
                {saving && <Loader2 size={14} className="animate-spin" />}
                {saved ? t('admin_settings.saved') : t('profile.run_save')}
              </button>
            </div>
            <p className="text-xs text-zinc-500 mt-1">
              {t('profile.run_limit_effective', { n: settings.effective_run_limit, max: settings.admin_run_limit })}
              {capped && ` ${t('profile.run_limit_capped', { n: settings.admin_run_limit })}`}
            </p>
          </div>
          <p className="text-xs text-zinc-500">
            {t('profile.run_storage', {
              used: formatBytes(settings.storage_used_bytes),
              quota: formatBytes(settings.storage_quota_bytes),
            })}
          </p>
          {error && <p className="text-sm text-red-400">{error}</p>}
        </form>
      )}
    </div>
  )
}
