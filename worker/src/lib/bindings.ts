import type { D1Database } from '@cloudflare/workers-types'
import type { Env, DatabaseRow } from '../types'
import { appDbId } from './d1-http'

// Bindings that hold the app's own data and must never be exposed to the SQL editor.
const RESERVED_BINDINGS = new Set(['DB', 'KV', 'ASSETS'])
const BINDING_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/

export type QueryBindingResult = { ok: true; db: D1Database } | { ok: false; error: string }

// Resolves a user-registered binding name to a queryable D1 database. Used both when an admin
// registers a database and on every query, so rows registered before this check existed
// (e.g. binding "DB") can no longer reach the management database.
export function resolveQueryBinding(env: Env, name: unknown): QueryBindingResult {
  if (typeof name !== 'string' || !BINDING_NAME_RE.test(name)) {
    return { ok: false, error: 'Invalid binding name.' }
  }
  if (RESERVED_BINDINGS.has(name)) {
    return { ok: false, error: `Binding "${name}" is reserved and cannot be queried.` }
  }
  const binding = env[name]
  if (!binding || typeof (binding as Record<string, unknown>).prepare !== 'function') {
    return { ok: false, error: `Binding "${name}" is not a D1 database on this Worker.` }
  }
  return { ok: true, db: binding as D1Database }
}

// How a registered database is executed: over the D1 HTTP API (new), or a legacy Worker binding
// (during the migration, until the admin re-links it).
export type QueryTarget = { kind: 'binding'; d1: D1Database } | { kind: 'http'; databaseId: string }

export type QueryTargetResult = { ok: true; target: QueryTarget } | { ok: false; error: string }

// Resolves a registered database row to its execution target. Rows with a cf_database_id run over
// the HTTP API (and the application's own database is refused), rows without fall back to their
// binding. The app-DB exclusion fails closed: without ZETA_APP_DB_ID configured the HTTP path
// cannot prove a database is not the app DB, so it refuses to run.
export function resolveQueryTarget(env: Env, db: DatabaseRow): QueryTargetResult {
  if (db.cf_database_id) {
    const appId = appDbId(env)
    if (!appId) {
      return { ok: false, error: 'ZETA_APP_DB_ID is not configured on this Worker.' }
    }
    if (db.cf_database_id === appId) {
      return { ok: false, error: 'This database is the application database and cannot be queried.' }
    }
    return { ok: true, target: { kind: 'http', databaseId: db.cf_database_id } }
  }
  const binding = resolveQueryBinding(env, db.binding_name)
  if (!binding.ok) return binding
  return { ok: true, target: { kind: 'binding', d1: binding.db } }
}
