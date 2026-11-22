import { History } from 'lucide-react'
import { formatBytes } from '../lib/format'
import { useLocale } from '../hooks/useLocale'
import type { RunSettings } from '../types'

export interface RunSettingsCardProps {
  settings: RunSettings | null
  value: string
  onChange: (value: string) => void
  onSave?: () => void
  error?: string
  loading?: boolean
}

// Profile card: how many runs per notebook the user keeps (at most the admin limit) and how much
// of their storage quota the saved results use.
// Save action is managed via the unified StickySaveBar on the Profile page.
export default function RunSettingsCard({
  settings,
  value,
  onChange,
  onSave,
  error,
  loading = false,
}: RunSettingsCardProps) {
  const { t } = useLocale()

  const capped = settings !== null && settings.run_limit !== null && settings.run_limit > settings.admin_run_limit

  return (
    <div className="card p-5">
      <h2 className="text-heading text-ink-900 mb-4 flex items-center gap-2">
        <History size={15} className="text-ink-500" /> {t('profile.run_title')}
      </h2>
      {!settings || loading ? (
        error ? (
          <p className="text-body text-danger-600">{error}</p>
        ) : (
          <p className="text-body text-ink-500">{t('common.loading')}</p>
        )
      ) : (
        <div className="space-y-3">
          <div>
            <label htmlFor="profile-run-limit" className="label">
              {t('profile.run_limit')}
            </label>
            <input
              id="profile-run-limit"
              type="number"
              min={1}
              max={settings.admin_run_limit}
              step={1}
              className="input"
              placeholder={t('profile.run_limit_placeholder', { n: settings.admin_run_limit })}
              value={value}
              onChange={(e) => onChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && onSave) {
                  e.preventDefault()
                  onSave()
                }
              }}
            />
            <p className="text-caption text-ink-500 mt-1 tnum">
              {t('profile.run_limit_effective', { n: settings.effective_run_limit, max: settings.admin_run_limit })}
              {capped && ` ${t('profile.run_limit_capped', { n: settings.admin_run_limit })}`}
            </p>
          </div>
          <p className="text-caption text-ink-500 tnum">
            {t('profile.run_storage', {
              used: formatBytes(settings.storage_used_bytes),
              quota: formatBytes(settings.storage_quota_bytes),
            })}
          </p>
          {error && <p className="text-body text-danger-600">{error}</p>}
        </div>
      )}
    </div>
  )
}
