import { ExternalLink } from 'lucide-react'
import { useState } from 'react'
import { useLocale } from '../hooks/useLocale'
import { ApiError, sparkUiApi } from '../lib/api'
import { errorCodeText } from '../lib/error-copy'
import type { Database } from '../types'

interface Props {
  selectedDb: Database | null | undefined
  onSelect: () => void
  onError?: (error: string) => void
}

/**
 * The Spark UI entry rendered at the bottom of the database switcher dropdown: only visible when
 * the currently selected target is Spark and its UI credentials are configured (`has_spark_ui: true`).
 * Clicking sends a bootstrap request (POST /api/spark-ui/session) to establish the signed session cookie,
 * then opens /spark-ui/ in a new tab and closes the dropdown. Every other engine renders null.
 */
export default function SparkUiMenuLink({ selectedDb, onSelect, onError }: Props) {
  const { t } = useLocale()
  const [loading, setLoading] = useState(false)

  if (selectedDb?.kind !== 'spark' || !selectedDb.has_spark_ui) {
    return null
  }

  const handleClick = async () => {
    if (!selectedDb?.id || loading) return
    setLoading(true)
    try {
      await sparkUiApi.createSession(selectedDb.id)
      window.open('/spark-ui/', '_blank', 'noopener,noreferrer')
      onSelect()
    } catch (err) {
      const msg =
        err instanceof TypeError
          ? t('errors.network_offline')
          : ((err instanceof ApiError ? errorCodeText(t, err.body) : null) ??
            (err instanceof Error ? err.message : t('errors.generic')))
      onError?.(msg)
    } finally {
      setLoading(false)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      handleClick()
    }
  }

  return (
    <>
      <hr className="h-px bg-ink-200 border-0" />
      <button
        type="button"
        disabled={loading}
        onClick={handleClick}
        onKeyDown={handleKeyDown}
        className="flex items-center justify-between w-full px-4 py-2.5 text-body text-ink-700 hover:bg-ink-100 transition-colors duration-(--duration-base) disabled:opacity-50 text-left"
      >
        <span>{t('spark.spark_ui')}</span>
        <ExternalLink size={13} className="text-ink-400 shrink-0" aria-hidden="true" />
      </button>
    </>
  )
}
