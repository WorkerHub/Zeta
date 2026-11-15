import type { Env } from '../types'
import { tables } from './db'

// ── Spark config profiles (§5.1/§5.2/§3) ─────────────────────────────────────────────────────
// A Spark profile is one user's saved set of runtime Spark SQLConf entries for one Spark target.
// Save-time validation (shared by the profile routes) enforces the §5.2 shape rules and the §3
// limits; the query paths resolve a `profileId` into the `config` object handed to the Spark
// executor (see lib/spark-executor.ts). A profile that is absent, foreign or on a non-Spark
// target resolves to null — the default session, never an error and never an existence leak.

export const MAX_PROFILES_PER_DB = 20
export const MAX_PROFILE_ENTRIES = 50
export const MAX_PROFILE_KEY_LENGTH = 128
export const MAX_PROFILE_VALUE_LENGTH = 512

// A runtime key: `spark.sql.` followed by letters, digits, dots and underscores (§5.2).
export const PROFILE_KEY_PATTERN = /^spark\.sql\.[A-Za-z0-9_.]+$/

// The startup-level static keys a profile must refuse (§5.2): these cannot change at session time
// and belong in the instance configuration instead.
export function isStartupLevelKey(key: string): boolean {
  return key === 'spark.sql.extensions' || key === 'spark.sql.warehouse.dir' || /^spark\.sql\.catalog\./.test(key)
}

export interface ProfileEntry {
  key: string
  value: string
}

export type ProfileEntriesResult =
  | { ok: true; entries: ProfileEntry[] }
  // A rejected key: the code matches the service's §1.1 answer, so the UI can point at the key.
  | { ok: false; kind: 'key'; code: 'startup_key_in_profile' | 'invalid_key'; key: string }
  // A profile-level limit with no single key to name (too many entries).
  | { ok: false; kind: 'limit'; error: string }

// Classifies one trimmed key: a runtime `spark.sql.*` key is ok, every other `spark.*` key (and the
// three static `spark.sql.*` items) is startup-level (§2), and anything else is invalid.
function classifyKey(key: string): 'ok' | 'startup' | 'invalid' {
  if (isStartupLevelKey(key)) return 'startup'
  if (key.startsWith('spark.')) return PROFILE_KEY_PATTERN.test(key) ? 'ok' : 'startup'
  return 'invalid'
}

// Validates one profile save's `entries` (§5.2 + §3). A blank line (both key and value empty or
// whitespace) is dropped, never stored; every other line must carry a non-empty key and value, a
// runtime-shaped key, and stay within the §3 length limits — and no key may repeat.
export function validateProfileEntries(raw: unknown): ProfileEntriesResult {
  if (!Array.isArray(raw)) return { ok: false, kind: 'key', code: 'invalid_key', key: '' }
  const seen = new Set<string>()
  const entries: ProfileEntry[] = []
  for (const item of raw) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      return { ok: false, kind: 'key', code: 'invalid_key', key: '' }
    }
    const k = (item as Record<string, unknown>).key
    const v = (item as Record<string, unknown>).value
    if (typeof k !== 'string' || typeof v !== 'string') {
      return { ok: false, kind: 'key', code: 'invalid_key', key: '' }
    }
    const key = k.trim()
    const value = v.trim()
    if (!key && !value) continue // blank line: ignored at save
    if (!key || !value) return { ok: false, kind: 'key', code: 'invalid_key', key }
    const classed = classifyKey(key)
    if (classed === 'startup') return { ok: false, kind: 'key', code: 'startup_key_in_profile', key }
    if (classed === 'invalid') return { ok: false, kind: 'key', code: 'invalid_key', key }
    if (key.length > MAX_PROFILE_KEY_LENGTH || value.length > MAX_PROFILE_VALUE_LENGTH) {
      return { ok: false, kind: 'key', code: 'invalid_key', key }
    }
    if (seen.has(key)) return { ok: false, kind: 'key', code: 'invalid_key', key }
    seen.add(key)
    entries.push({ key, value })
  }
  if (entries.length > MAX_PROFILE_ENTRIES) {
    return { ok: false, kind: 'limit', error: `Maximum ${MAX_PROFILE_ENTRIES} entries per profile` }
  }
  return { ok: true, entries }
}

// The `config` object a validated profile contributes to a session (§1.1).
export function entriesToConfig(entries: ProfileEntry[]): Record<string, string> {
  const config: Record<string, string> = {}
  for (const { key, value } of entries) config[key] = value
  return config
}

// Reads back the stored `entries` JSON. A corrupt row yields no entries (defensive: the query path
// then falls back to the default session rather than failing).
export function parseStoredEntries(text: string): ProfileEntry[] {
  try {
    const parsed: unknown = JSON.parse(text)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (e): e is ProfileEntry =>
        e !== null &&
        typeof e === 'object' &&
        !Array.isArray(e) &&
        typeof (e as Record<string, unknown>).key === 'string' &&
        typeof (e as Record<string, unknown>).value === 'string'
    )
  } catch {
    return []
  }
}

// Resolves a caller's selected profile to its runtime config. Null means "default session, no
// `config` field" — the answer for an absent/blank/foreign profile id, a missing row, or a row
// whose entries no longer parse to anything usable. It never reveals whether the id exists.
export async function loadProfileConfig(
  env: Env,
  userId: string,
  databaseId: string,
  profileId: unknown
): Promise<Record<string, string> | null> {
  if (typeof profileId !== 'string' || !profileId.trim()) return null
  const T = tables(env)
  const row = await env.DB.prepare(
    `SELECT entries FROM ${T.spark_config_profiles} WHERE id = ?1 AND user_id = ?2 AND database_id = ?3`
  )
    .bind(profileId.trim(), userId, databaseId)
    .first<{ entries: string }>()
  if (!row) return null
  const entries = parseStoredEntries(row.entries)
  return entries.length ? entriesToConfig(entries) : null
}

// ── The Spark session one request runs on (§5.1/§9.1) ─────────────────────────────────────────
// The service applies a request's `config` to the named session on every request and never resets
// what an earlier request set: a session that once carried a profile keeps those values, and a
// request that carries no config changes nothing at all — which is exactly the "default
// configuration" case, so a user switching back to the default used to keep the profile's values
// until the instance restarted. One session key per effective config is the way back: the default
// configuration owns a key no profile request can ever use, so it can only ever hold Spark's
// defaults, and a profile owns a key derived from its own entries, so two profiles can never share
// a session and a key dropped from a profile cannot linger.
const SPARK_SESSION_PREFIX = 'zeta:'

export async function sparkSessionKey(userId: string, config: Record<string, string> | null): Promise<string> {
  if (!config || !Object.keys(config).length) return `${SPARK_SESSION_PREFIX}${userId}:default`
  // Order-independent: the same entries in another order are the same configuration.
  const canonical = JSON.stringify(Object.entries(config).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical))
  const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 16)
  // `:p…` never collides with `:default`, so even a (negligible) digest collision between two
  // profiles only makes them share a session — each request still applies its own config.
  return `${SPARK_SESSION_PREFIX}${userId}:p${hex}`
}
