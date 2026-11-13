// Registration form state for connection-string targets (PostgreSQL, and MySQL = TiDB Cloud
// Starter). The module keeps its original file name; every connection-string engine shares these
// helpers.
//
// The backend tests the connection again when it stores the registration, so this is only the
// form's own gate: a passing test vouches for the one string it ran against, and nothing else.

import type { DbKind } from '../types'

/** Engines that are registered from a pasted connection string, not from the D1 picker. */
export type ConnectionStringKind = 'postgres' | 'mysql'

export type ConnectionTestState = 'idle' | 'testing' | 'passed' | 'failed'

/** Whether the string currently in the form is the one whose test connection passed. */
export function canSaveConnectionString(url: string, testedUrl: string | null): boolean {
  const current = url.trim()
  return current !== '' && current === testedUrl
}

/**
 * Translation keys of the registration card's title and description for an engine. Each engine
 * names what it registers: MySQL is TiDB Cloud Starter only (regular MySQL/MariaDB is refused).
 */
export function registerCopyKeys(kind: DbKind): { title: string; desc: string } {
  switch (kind) {
    case 'postgres':
      return { title: 'admin_db.register_title_pg', desc: 'admin_db.register_desc_pg' }
    case 'mysql':
      return { title: 'admin_db.register_title_mysql', desc: 'admin_db.register_desc_mysql' }
    default:
      return { title: 'admin_db.register_title', desc: 'admin_db.register_desc' }
  }
}

/** Human-readable detail for a passing test, e.g. "PostgreSQL 18.6 · 320 ms" (empty if neither). */
export function describeTestResult(res: { server_version?: string; latency_ms?: number }): string {
  const parts: string[] = []
  if (res.server_version) parts.push(res.server_version)
  if (typeof res.latency_ms === 'number' && Number.isFinite(res.latency_ms)) {
    parts.push(`${Math.round(res.latency_ms)} ms`)
  }
  return parts.join(' · ')
}
