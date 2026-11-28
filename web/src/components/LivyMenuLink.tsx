import { Layers, Terminal } from 'lucide-react'
import { useLocale } from '../hooks/useLocale'
import type { Database } from '../types'

interface Props {
  selectedDb: Database | null | undefined
  onOpenConsole: () => void
  onOpenBatches: () => void
}

/**
 * The Livy entries rendered at the bottom of the database switcher dropdown: only visible when
 * the currently selected target is Spark and its Livy credentials are configured (`has_livy: true`).
 * Clicking either action opens the Livy dialog with the corresponding tab and closes the dropdown.
 */
export default function LivyMenuLink({ selectedDb, onOpenConsole, onOpenBatches }: Props) {
  const { t } = useLocale()

  if (selectedDb?.kind !== 'spark' || !selectedDb.has_livy) {
    return null
  }

  return (
    <>
      <hr className="h-px bg-ink-200 border-0" />
      <button
        type="button"
        onClick={onOpenConsole}
        className="flex items-center justify-between w-full px-4 py-2.5 text-body text-ink-700 hover:bg-ink-100 transition-colors duration-(--duration-base) text-left"
      >
        <span>{t('livy.console')}</span>
        <Terminal size={13} className="text-ink-400 shrink-0" aria-hidden="true" />
      </button>
      <button
        type="button"
        onClick={onOpenBatches}
        className="flex items-center justify-between w-full px-4 py-2.5 text-body text-ink-700 hover:bg-ink-100 transition-colors duration-(--duration-base) text-left"
      >
        <span>{t('livy.batches')}</span>
        <Layers size={13} className="text-ink-400 shrink-0" aria-hidden="true" />
      </button>
    </>
  )
}
