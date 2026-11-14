// ── Spark *instance* configuration (SPEC §6.2 limits and rules) ─────────────────────────────────
// The reader-facing half of the validation the worker owns in worker/src/lib/spark-config.ts: the
// same keys, the same limits and the same split between startup-level and runtime parameters, so a
// row the dialog accepts is never rejected for a reason it could have shown inline. Only the copy
// differs — the dialog names the offending row and says where the parameter belongs instead.
//
// This module also holds the small derivations the dialog needs: the display name of a jar, its
// state against the service's jar listing, and whether the draft differs from what the service is
// actually running (the status line's "unapplied changes").

import type { JarRef, ProfileEntry, ServerJar, SparkConfigStatus } from '../types'

// §3 limits, matching INSTANCE_* in worker/src/lib/spark-config.ts.
export const INSTANCE_ENTRIES_MAX = 50
export const INSTANCE_JARS_MAX = 20
export const INSTANCE_KEY_MAX = 128
export const INSTANCE_VALUE_MAX = 512

// §6.2 entry-key rules.
const ENTRY_KEY_RE = /^spark\.[A-Za-z0-9_.]+$/
// A Spark memory size: a number with an optional single-unit suffix (`4g`), never `4X`.
const MEMORY_VALUE_RE = /^[0-9]+[kKmMgGtT]?$/
const URL_RE = /^https?:\/\//i
const SHA256_RE = /^[0-9a-f]{64}$/
const CATALOG_RE = /^spark\.sql\.catalog\./

// §2 startup-level `spark.sql.*` static items: every other `spark.sql.*` key is a runtime parameter
// that belongs in the caller's personal config profile (SPEC §5.2), not in the instance config.
const STARTUP_SQL_KEYS = new Set(['spark.sql.extensions', 'spark.sql.warehouse.dir'])

/** Why one `key = value` row is not acceptable, or null when it is. */
export type InstanceEntryError = 'invalid_key' | 'runtime_key' | 'jars_key' | 'bad_memory' | 'too_long'

/** Why one jar row is not acceptable, or `ok` with the reference it produces. */
export type InstanceJarError = 'bad_filename' | 'bad_sha256'

function isRuntimeSqlKey(key: string): boolean {
  return key.startsWith('spark.sql.') && !STARTUP_SQL_KEYS.has(key) && !CATALOG_RE.test(key)
}

/**
 * Validates one instance-config entry (§6.2). A blank line (both fields empty) is not an error — it
 * is dropped at save. Every other line needs a startup-level `spark.*` key and a value within the
 * §3 limits; a `*.memory` key must carry a Spark memory size.
 */
export function validateInstanceEntry(key: string, value: string): InstanceEntryError | null {
  const k = key.trim()
  const v = value.trim()
  if (!k && !v) return null
  if (!k || !v) return 'invalid_key'
  if (!ENTRY_KEY_RE.test(k)) return 'invalid_key'
  if (k === 'spark.jars') return 'jars_key'
  if (isRuntimeSqlKey(k)) return 'runtime_key'
  if (k.endsWith('.memory') && !MEMORY_VALUE_RE.test(v)) return 'bad_memory'
  if (k.length > INSTANCE_KEY_MAX || v.length > INSTANCE_VALUE_MAX) return 'too_long'
  return null
}

export type InstanceJarParse = { ok: true; ref: JarRef } | { ok: false; code: InstanceJarError }

/**
 * Turns one jar row into the reference the API stores (§6.2). A value starting with `http://` or
 * `https://` is a URL the service downloads — it may pin a sha256 of 64 lowercase hex characters.
 * Anything else is a file name already in the service's jars directory: no path separators, no `..`.
 */
export function parseJarInput(value: string, sha256 = ''): InstanceJarParse {
  const v = value.trim()
  const sum = sha256.trim().toLowerCase()
  if (!v) return { ok: false, code: 'bad_filename' }

  if (URL_RE.test(v)) {
    if (sum && !SHA256_RE.test(sum)) return { ok: false, code: 'bad_sha256' }
    return { ok: true, ref: sum ? { type: 'url', value: v, sha256: sum } : { type: 'url', value: v } }
  }

  if (v.includes('/') || v.includes('\\') || v.includes('..')) return { ok: false, code: 'bad_filename' }
  // A sha256 pins a download; a file already on the server has nothing to verify.
  if (sum) return { ok: false, code: 'bad_sha256' }
  return { ok: true, ref: { type: 'file', value: v } }
}

/** The file name a jar reference lands under in the service's jars directory. */
export function jarDisplayName(ref: JarRef): string {
  if (ref.type === 'file') return ref.value
  try {
    const { pathname } = new URL(ref.value)
    const last = pathname.split('/').filter(Boolean).pop() ?? ''
    return decodeURIComponent(last)
  } catch {
    return ref.value
  }
}

/**
 * What the row's chip says: a URL is fetched by the service, a file name is looked up in its jar
 * listing. With no listing to compare against (service unreachable) the chip is omitted.
 */
export type JarServerState = 'download' | 'present' | 'missing' | 'unknown'

export function jarServerState(ref: JarRef, serverJars: ServerJar[] | null): JarServerState {
  if (ref.type === 'url') return 'download'
  if (serverJars === null) return 'unknown'
  return serverJars.some((jar) => jar.name === ref.value) ? 'present' : 'missing'
}

/** The draft's entries as an object (blank rows dropped), the shape the API stores. */
export function rowsToEntries(rows: ProfileEntry[]): Record<string, string> {
  const entries: Record<string, string> = {}
  for (const row of rows) {
    const k = row.key.trim()
    if (!k) continue
    entries[k] = row.value.trim()
  }
  return entries
}

/** A stored config's entries as ordered editor rows; an empty config still shows one blank line. */
export function entriesToRows(entries: Record<string, string>): ProfileEntry[] {
  const rows = Object.entries(entries).map(([key, value]) => ({ key, value }))
  return rows.length > 0 ? rows : [{ key: '', value: '' }]
}

function sameStringMultiset(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  const left = [...a].sort()
  const right = [...b].sort()
  return left.every((value, i) => value === right[i])
}

/** Whether two entries objects hold the same keys with the same values. */
export function sameEntries(a: Record<string, string>, b: Record<string, string>): boolean {
  const left = Object.keys(a)
  if (left.length !== Object.keys(b).length) return false
  return left.every((key) => b[key] === a[key])
}

/** Whether the draft's rows carry the same entries a stored config holds. */
export function rowsMatchEntries(rows: ProfileEntry[], entries: Record<string, string>): boolean {
  return sameEntries(rowsToEntries(rows), entries)
}

/** Whether the draft's jars land under the same file names a stored jar list uses. */
export function jarRefsMatch(a: JarRef[], b: JarRef[]): boolean {
  return sameStringMultiset(
    a.map((ref) => jarDisplayName(ref)),
    b.map((ref) => jarDisplayName(ref))
  )
}

/**
 * Whether the draft differs from what the service reports as effective — the status line's
 * "unapplied changes". Entries compare by key and value; jars by the file name they land under
 * (`jarDisplayName`), since the service reports loaded files, not the references it downloaded.
 * With no status to compare against (service unreachable) there is nothing to claim either way.
 */
export function isInstancePending(rows: ProfileEntry[], jars: JarRef[], status: SparkConfigStatus | null): boolean {
  if (status === null) return false
  if (!rowsMatchEntries(rows, status.effective.entries ?? {})) return true
  return !sameStringMultiset(
    jars.map((ref) => jarDisplayName(ref)),
    status.effective.jars ?? []
  )
}
