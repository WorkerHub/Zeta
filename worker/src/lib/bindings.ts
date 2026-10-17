import type { D1Database } from '@cloudflare/workers-types'
import type { Env } from '../types'

// Bindings that hold the app's own data and must never be exposed to the SQL editor.
const RESERVED_BINDINGS = new Set(['DB', 'KV', 'ASSETS'])
const BINDING_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/

export type QueryBindingResult =
  | { ok: true; db: D1Database }
  | { ok: false; error: string }

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
