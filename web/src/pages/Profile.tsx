import { useState, useEffect } from 'react'
import { Shield } from 'lucide-react'
import { useOutletContext } from 'react-router-dom'
import { profileApi } from '../lib/api'
import { useLocale } from '../hooks/useLocale'
import { useThemeColor } from '../hooks/useThemeColor'
import RunSettingsCard from '../components/RunSettingsCard'
import ThemeColorCard from '../components/ThemeColorCard'
import StickySaveBar from '../components/StickySaveBar'
import type { AccountOutletContext } from './AccountLayout'
import type { User, RunSettings } from '../types'

export default function ProfilePage() {
  const { t } = useLocale()
  const { themeColor, setThemeColor, syncError } = useThemeColor()
  const outletContext = useOutletContext<AccountOutletContext | null>()

  const [user, setUser] = useState<User | null>(null)
  const [loadingUser, setLoadingUser] = useState(true)

  // Run settings
  const [settings, setSettings] = useState<RunSettings | null>(null)
  const [loadingSettings, setLoadingSettings] = useState(true)
  const [initialRunLimit, setInitialRunLimit] = useState('')
  const [runLimitValue, setRunLimitValue] = useState('')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [runError, setRunError] = useState('')

  useEffect(() => {
    profileApi
      .me()
      .then(setUser)
      .finally(() => setLoadingUser(false))
  }, [])

  useEffect(() => {
    profileApi
      .runSettings()
      .then((s) => {
        setSettings(s)
        const val = s.run_limit === null ? '' : String(s.run_limit)
        setRunLimitValue(val)
        setInitialRunLimit(val)
      })
      .catch(() => setRunError(t('errors.load_run_settings_failed')))
      .finally(() => setLoadingSettings(false))
  }, [t])

  const dirty = settings !== null && runLimitValue !== initialRunLimit

  useEffect(() => {
    outletContext?.setDirty(dirty)
    return () => {
      outletContext?.setDirty(false)
    }
  }, [dirty, outletContext])

  useEffect(() => {
    if (!dirty) return
    function handleBeforeUnload(e: BeforeUnloadEvent) {
      e.preventDefault()
    }
    window.addEventListener('beforeunload', handleBeforeUnload)
    return () => window.removeEventListener('beforeunload', handleBeforeUnload)
  }, [dirty])

  async function saveRunSettings() {
    if (!settings) return
    const trimmed = runLimitValue.trim()
    const n = Number(trimmed)
    if (trimmed && (!Number.isInteger(n) || n < 1 || n > settings.admin_run_limit)) {
      setRunError(t('profile.run_limit_invalid', { max: settings.admin_run_limit }))
      return
    }
    setSaving(true)
    setRunError('')
    setSaved(false)
    try {
      const updated = await profileApi.updateRunSettings({ run_limit: trimmed ? n : null })
      setSettings(updated)
      const nextVal = updated.run_limit === null ? '' : String(updated.run_limit)
      setRunLimitValue(nextVal)
      setInitialRunLimit(nextVal)
      setSaved(true)
      setTimeout(() => setSaved(false), 3000)
    } catch (err) {
      setRunError(err instanceof Error ? err.message : t('errors.save_failed'))
    } finally {
      setSaving(false)
    }
  }

  if (loadingUser && !user) {
    return <div className="flex items-center justify-center p-12 text-ink-500 text-body">{t('common.loading')}</div>
  }

  return (
    <div className="flex flex-col min-h-[calc(100vh-120px)] justify-between">
      <div className="max-w-2xl w-full mx-auto px-6 py-4 flex flex-col gap-8 pb-20 sm:pb-24">
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
              <span className={`badge ${user?.role === 'admin' ? 'badge-brand' : 'badge-neutral'}`}>{user?.role}</span>
            </div>
          </div>
        </div>

        {/* Theme colour */}
        <ThemeColorCard value={themeColor} onChange={setThemeColor} syncError={syncError} />

        {/* Saved query runs */}
        <RunSettingsCard
          settings={settings}
          value={runLimitValue}
          onChange={setRunLimitValue}
          onSave={() => void saveRunSettings()}
          error={runError}
          loading={loadingSettings}
        />
      </div>

      <StickySaveBar
        dirty={dirty}
        saving={saving}
        saved={saved}
        error={runError}
        onSave={() => void saveRunSettings()}
      />
    </div>
  )
}
