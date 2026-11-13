import { useLocale } from '../hooks/useLocale'
import { effectiveProvider, engineLabelKey } from '../lib/db-provider'
import type { DbKind } from '../types'

interface Props {
  kind?: DbKind
  /** The registration's own provider text; absent means the provider is derived from the kind. */
  provider?: string | null
  className?: string
}

// The engine and the provider of a connection, as one pair, nothing at all in place of a missing
// provider. It sits in a switcher menu's rows, beside the target's name, and the provider is the
// effective one (lib/db-provider.ts).
//
// Two levels of quiet, so the pair reads as one line and its two halves still rank: the engine in
// ink-500, the provider one step further back in ink-400, and the separating dot between them
// quieter still in ink-300 — all of them existing tokens, so light and dark follow on their own.
export default function DbKindMeta({ kind, provider, className = '' }: Props) {
  const { t } = useLocale()
  const providerLabel = effectiveProvider(kind, provider)

  return (
    <span
      className={`inline-flex min-w-0 max-w-full items-center gap-1.5 whitespace-nowrap text-caption ${className}`.trim()}
    >
      <span className="shrink-0 font-medium text-ink-500">{t(engineLabelKey(kind))}</span>
      {providerLabel && (
        <>
          <span aria-hidden="true" className="shrink-0 text-ink-300">
            ·
          </span>
          <span className="min-w-0 truncate text-ink-400" title={providerLabel}>
            {providerLabel}
          </span>
        </>
      )}
    </span>
  )
}
