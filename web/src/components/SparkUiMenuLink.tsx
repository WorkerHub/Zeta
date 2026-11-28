import { ExternalLink } from 'lucide-react'
import { useLocale } from '../hooks/useLocale'
import type { Database } from '../types'

interface Props {
  selectedDb: Database | null | undefined
  onSelect: () => void
}

/**
 * The Spark UI entry rendered at the bottom of the database switcher dropdown: only visible when
 * the currently selected target is Spark and its UI credentials are configured (`has_spark_ui: true`).
 * Clicking opens the service UI via Zeta's signed reverse-proxy route in a new tab and closes the
 * dropdown. Every other engine renders null.
 */
export default function SparkUiMenuLink({ selectedDb, onSelect }: Props) {
  const { t } = useLocale()

  if (selectedDb?.kind !== 'spark' || !selectedDb.has_spark_ui) {
    return null
  }

  return (
    <>
      <hr className="h-px bg-ink-200 border-0" />
      <a
        href={`/spark-ui/?db=${encodeURIComponent(selectedDb.id)}`}
        target="_blank"
        rel="noopener noreferrer"
        onClick={onSelect}
        className="flex items-center justify-between w-full px-4 py-2.5 text-body text-ink-700 hover:bg-ink-100 transition-colors duration-(--duration-base)"
      >
        <span>{t('spark.spark_ui')}</span>
        <ExternalLink size={13} className="text-ink-400 shrink-0" aria-hidden="true" />
      </a>
    </>
  )
}
