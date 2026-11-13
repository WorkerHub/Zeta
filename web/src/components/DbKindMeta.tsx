import { useLocale } from '../hooks/useLocale'
import type { DbKind } from '../types'

// The provider a connection runs on, derived from the kind alone: the API has no provider column,
// and Zeta registers exactly one provider per engine — SQLite on Cloudflare D1, MySQL on TiDB
// Cloud Starter (never a plain MySQL server), PostgreSQL on Neon, Spark on none.
type Provider = 'd1' | 'neon' | 'tidb'

function providerOf(kind: DbKind | undefined): Provider | null {
  switch (kind) {
    case 'postgres':
      return 'neon'
    case 'mysql':
      return 'tidb'
    case 'spark':
      return null
    default:
      // Registrations written before the kind column exist are D1 databases
      return 'd1'
  }
}

// One label per engine, the same words the admin panel uses; an unknown kind is never shown as a
// known engine. SQLite is the exception: the admin label reads "Cloudflare D1", which here would
// repeat the provider shown beside it.
function kindLabel(kind: DbKind | undefined, t: (key: string) => string): string {
  switch (kind) {
    case 'postgres':
      return t('admin_db.kind_postgres')
    case 'mysql':
      return t('admin_db.kind_mysql')
    case 'spark':
      return t('admin_db.kind_spark')
    default:
      return t('query.kind_sqlite')
  }
}

// The engine and the provider of a connection, as one pair after the name: the engine in the
// info accent, the provider in the ordinary text colour, nothing at all in place of a missing
// provider. Shared by the database switcher's rows and its current-connection button so the two
// never drift apart.
export default function DbKindMeta({ kind, className = '' }: { kind?: DbKind; className?: string }) {
  const { t } = useLocale()
  const provider = providerOf(kind)
  const providerLabel = provider
    ? { d1: t('query.provider_d1'), neon: t('query.provider_neon'), tidb: t('query.provider_tidb') }[provider]
    : null

  return (
    <span className={`inline-flex items-center gap-1.5 text-caption whitespace-nowrap ${className}`.trim()}>
      <span className="font-medium text-info-600">{kindLabel(kind, t)}</span>
      {providerLabel && (
        <>
          <span aria-hidden="true" className="text-ink-300">
            ·
          </span>
          <span className="text-ink-700">{providerLabel}</span>
        </>
      )}
    </span>
  )
}
