import type { DbKind } from '../types'

// How a target's engine and provider read, everywhere they are shown: the query page's switcher and
// the admin panel's list. One place, so the two never drift apart.

// The provider a target runs on. A registration may carry its own text (pure display, never used in
// a decision); without one it is the provider Zeta registers that engine on — SQLite on Cloudflare
// D1, MySQL on TiDB Cloud Starter, PostgreSQL on Neon, Spark on none. Brand names read the same in
// both locales, so no translation key is involved.
export function effectiveProvider(kind: DbKind | undefined, custom?: string | null): string | null {
  const own = custom?.trim()
  if (own) return own
  switch (kind) {
    case 'postgres':
      return 'Neon'
    case 'mysql':
      return 'TiDB'
    case 'spark':
      return null
    default:
      // Registrations written before the kind column exist are D1 databases
      return 'D1'
  }
}

// The engine's label for the switcher and the admin list: the SQL names people know the engine by.
// The admin registration form's picker keeps its own copy (it reads "Cloudflare D1" there, where the
// choice is which kind of target to create).
export function engineLabelKey(kind: DbKind | undefined): string {
  switch (kind) {
    case 'postgres':
      return 'admin_db.kind_postgres'
    case 'mysql':
      return 'admin_db.kind_mysql'
    case 'spark':
      return 'admin_db.kind_spark'
    default:
      return 'query.kind_sqlite'
  }
}
