// Per-target Spark profile state, kept in this tab's sessionStorage — the same shape and lifetime
// as the connection state (lib/connection-state.ts): a selected profile is a fact about "this
// browser session, this target", never a server-side fact, and a fresh device therefore starts on
// the default configuration (SPEC §5.3). A target with no entry means "default" — the page never
// stores a sentinel, so the request simply omits `profileId`.

export const SELECTED_PROFILES_KEY = 'zeta:spark-selected-profiles'
// The profile a live connection was made with: when the selection moves off it while the target is
// connected, the connect button turns into "reconnect" (SPEC §5.3).
export const CONNECTED_PROFILES_KEY = 'zeta:spark-connected-profiles'

/** Profile id per target id (a target with no entry is on the default configuration). */
export type SparkProfileMap = Record<string, string>

// ── §5.2 save-time validation (shared with the worker, see worker/src/lib/spark-profile.ts) ──────

export const MAX_PROFILE_ENTRIES = 50
export const MAX_PROFILE_KEY_LENGTH = 128
export const MAX_PROFILE_VALUE_LENGTH = 512

// A runtime key: `spark.sql.` followed by letters, digits, dots and underscores.
export const PROFILE_KEY_PATTERN = /^spark\.sql\.[A-Za-z0-9_.]+$/

// The startup-level static keys a profile must refuse: they cannot change at session time and
// belong in the instance configuration instead.
export function isStartupLevelKey(key: string): boolean {
  return key === 'spark.sql.extensions' || key === 'spark.sql.warehouse.dir' || /^spark\.sql\.catalog\./.test(key)
}

// A rejected key, classified the same way the worker does so the dialog renders the right copy and
// points at the row.
export type ProfileKeyError = { code: 'startup_key_in_profile' | 'invalid_key'; key: string }

/**
 * Validates one trimmed key/value pair (§5.2). A blank line (both empty) is not an error — it is
 * dropped at save; every other line must carry a runtime-shaped key and a non-empty value within
 * the §3 length limits. Duplicate keys and the ≤50-line cap are list-level concerns the dialog
 * checks itself.
 */
export function validateProfileEntry(key: string, value: string): ProfileKeyError | null {
  const k = key.trim()
  const v = value.trim()
  if (!k && !v) return null
  if (!k || !v) return { code: 'invalid_key', key: k }
  if (isStartupLevelKey(k)) return { code: 'startup_key_in_profile', key: k }
  if (k.startsWith('spark.')) {
    if (!PROFILE_KEY_PATTERN.test(k)) return { code: 'startup_key_in_profile', key: k }
  } else {
    return { code: 'invalid_key', key: k }
  }
  if (k.length > MAX_PROFILE_KEY_LENGTH || v.length > MAX_PROFILE_VALUE_LENGTH) {
    return { code: 'invalid_key', key: k }
  }
  return null
}

// ── Storage (best-effort, defensive — see lib/connection-state.ts) ───────────────────────────────

function sessionStore(): Storage | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage
  } catch {
    return null
  }
}

export function parseProfileMap(raw: string | null): SparkProfileMap {
  if (!raw) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return {}
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
  const map: SparkProfileMap = {}
  for (const [id, profileId] of Object.entries(parsed as Record<string, unknown>)) {
    if (id !== '' && typeof profileId === 'string' && profileId !== '') map[id] = profileId
  }
  return map
}

function readMap(key: string): SparkProfileMap {
  try {
    return parseProfileMap(sessionStore()?.getItem(key) ?? null)
  } catch {
    return {}
  }
}

function writeMap(key: string, map: SparkProfileMap): void {
  try {
    sessionStore()?.setItem(key, JSON.stringify(map))
  } catch {
    // Nothing to do: the in-memory state still works for this page view.
  }
}

export function selectedProfileOf(map: SparkProfileMap, id: string): string | null {
  return map[id] ?? null
}

/** Remembers or clears the selection: a null profileId is the default configuration. */
export function rememberSelectedProfile(map: SparkProfileMap, id: string, profileId: string | null): SparkProfileMap {
  if (profileId === null) return forgetSelectedProfile(map, id)
  if (map[id] === profileId) return map
  return { ...map, [id]: profileId }
}

export function forgetSelectedProfile(map: SparkProfileMap, id: string): SparkProfileMap {
  if (!(id in map)) return map
  const rest = { ...map }
  delete rest[id]
  return rest
}

export function connectedProfileOf(map: SparkProfileMap, id: string): string | null {
  return map[id] ?? null
}

export function rememberConnectedProfile(map: SparkProfileMap, id: string, profileId: string | null): SparkProfileMap {
  if (profileId === null) return forgetConnectedProfile(map, id)
  if (map[id] === profileId) return map
  return { ...map, [id]: profileId }
}

export function forgetConnectedProfile(map: SparkProfileMap, id: string): SparkProfileMap {
  if (!(id in map)) return map
  const rest = { ...map }
  delete rest[id]
  return rest
}

// Selection state (the profile the next connect uses).
export function readSelectedProfiles(): SparkProfileMap {
  return readMap(SELECTED_PROFILES_KEY)
}
export function writeSelectedProfiles(map: SparkProfileMap): void {
  writeMap(SELECTED_PROFILES_KEY, map)
}

// The profile the live connection was made with (reconnect detection).
export function readConnectedProfiles(): SparkProfileMap {
  return readMap(CONNECTED_PROFILES_KEY)
}
export function writeConnectedProfiles(map: SparkProfileMap): void {
  writeMap(CONNECTED_PROFILES_KEY, map)
}
