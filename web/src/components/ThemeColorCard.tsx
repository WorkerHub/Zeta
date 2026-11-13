import { Palette } from 'lucide-react'
import { useLocale } from '../hooks/useLocale'
import ThemeColorPicker from './ThemeColorPicker'
import type { ThemeColor } from '../lib/theme-color'

// Profile card for the brand colour preset. Picking is immediate (the picker has no save button);
// the parent persists it through `useThemeColor` and surfaces the rollback error here when the
// server save failed.
export default function ThemeColorCard({
  value,
  onChange,
  syncError,
}: {
  value: ThemeColor
  onChange: (color: ThemeColor) => void
  syncError: string | null
}) {
  const { t } = useLocale()

  return (
    <div className="card p-5">
      <h2 className="text-heading text-ink-900 mb-4 flex items-center gap-2">
        <Palette size={15} className="text-ink-400" /> {t('profile.theme_color')}
      </h2>
      <ThemeColorPicker value={value} onChange={onChange} />
      {syncError && (
        <p role="alert" className="text-body text-danger-600 mt-3">
          {syncError}
        </p>
      )}
      <p className="text-caption text-ink-500 mt-3">{t('profile.theme_color_desc')}</p>
    </div>
  )
}
