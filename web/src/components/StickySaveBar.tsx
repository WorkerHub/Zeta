import { Check, Loader2, Save, AlertCircle } from 'lucide-react'
import { useLocale } from '../hooks/useLocale'

export interface StickySaveBarProps {
  dirty: boolean
  saving: boolean
  saved: boolean
  error?: string
  onSave: () => void
  saveText?: string
  unsavedText?: string
  savedText?: string
  savingText?: string
  className?: string
}

export default function StickySaveBar({
  dirty,
  saving,
  saved,
  error,
  onSave,
  saveText,
  unsavedText,
  savedText,
  savingText,
  className = '',
}: StickySaveBarProps) {
  const { t } = useLocale()

  const resolvedSaveText = saveText ?? t('admin_settings.save_changes')
  const resolvedUnsavedText = unsavedText ?? t('admin_settings.unsaved_changes')
  const resolvedSavedText = savedText ?? t('admin_settings.all_saved')
  const resolvedSavingText = savingText ?? t('auth.saving')

  return (
    <section
      aria-label="Save bar"
      className={`sticky bottom-0 z-(--z-sticky-bar) w-full bg-ink-0/95 backdrop-blur-sm border-t border-ink-200 safe-b shadow-xs ${className}`}
    >
      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-3 flex items-center justify-between gap-4">
        <div className="flex items-center gap-2 min-w-0">
          {error ? (
            <div role="alert" className="flex items-center gap-1.5 text-danger-600 text-caption sm:text-body min-w-0">
              <AlertCircle size={15} className="shrink-0" />
              <span className="truncate">{error}</span>
            </div>
          ) : saving ? (
            <div className="flex items-center gap-1.5 text-ink-500 text-caption sm:text-body">
              <Loader2 size={14} className="animate-spin shrink-0" />
              <span>{resolvedSavingText}</span>
            </div>
          ) : saved ? (
            <div className="flex items-center gap-1.5 text-success-600 text-caption sm:text-body font-medium">
              <Check size={15} className="shrink-0 animate-success-pop" />
              <span>{t('admin_settings.saved')}</span>
            </div>
          ) : dirty ? (
            <div className="flex items-center gap-1.5 text-ink-700 text-caption sm:text-body">
              <span className="w-2 h-2 rounded-full bg-brand-600 shrink-0" />
              <span>{resolvedUnsavedText}</span>
            </div>
          ) : (
            <div className="flex items-center gap-1.5 text-ink-500 text-caption sm:text-body">
              <Check size={14} className="text-ink-400 shrink-0" />
              <span>{resolvedSavedText}</span>
            </div>
          )}
        </div>

        <button type="button" onClick={onSave} disabled={saving || !dirty} className="btn-primary gap-2 shrink-0">
          {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
          {resolvedSaveText}
        </button>
      </div>
    </section>
  )
}
