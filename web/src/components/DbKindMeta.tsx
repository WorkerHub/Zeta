import { useLocale } from '../hooks/useLocale'
import { effectiveProvider, engineLabelKey } from '../lib/db-provider'
import type { DbKind } from '../types'

interface Props {
  kind?: DbKind
  /** The registration's own provider text; absent means the provider is derived from the kind. */
  provider?: string | null
  /**
   * 'muted' is the switcher button's second line: the whole pair one step smaller, in the quiet
   * text colour, under the name. 'default' is a row's own line, with the engine in the info accent.
   */
  tone?: 'default' | 'muted'
  className?: string
}

// The engine and the provider of a connection, as one pair, nothing at all in place of a missing
// provider. Shared by the database switcher's rows and its current-connection button so the two
// never drift apart, and the provider is the effective one (lib/db-provider.ts).
export default function DbKindMeta({ kind, provider, tone = 'default', className = '' }: Props) {
  const { t } = useLocale()
  const providerLabel = effectiveProvider(kind, provider)
  const muted = tone === 'muted'

  return (
    <span
      className={`inline-flex min-w-0 max-w-full items-center gap-1.5 whitespace-nowrap ${muted ? 'text-micro' : 'text-caption'} ${className}`.trim()}
    >
      <span className={`shrink-0 font-medium ${muted ? 'text-ink-500' : 'text-info-600'}`}>
        {t(engineLabelKey(kind))}
      </span>
      {providerLabel && (
        <>
          <span aria-hidden="true" className={`shrink-0 ${muted ? 'text-ink-400' : 'text-ink-300'}`}>
            ·
          </span>
          <span className={`min-w-0 truncate ${muted ? 'text-ink-500' : 'text-ink-700'}`} title={providerLabel}>
            {providerLabel}
          </span>
        </>
      )}
    </span>
  )
}
