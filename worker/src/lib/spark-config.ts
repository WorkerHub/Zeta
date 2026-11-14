// ── Spark *instance* configuration (SPEC §6) ──────────────────────────────────────────────────
// The expected config of a Spark target — a set of startup-level `spark.*` entries plus a jar list —
// stored in `spark_instance_configs` and applied to the service via its §1.2 admin endpoints.
// This module holds the shapes and the save-time validation (§6.2) in one place; the service calls
// that carry the config live in lib/spark-executor.ts, and the routes in routes/databases.ts.

export interface JarRef {
  type: 'url' | 'file'
  value: string
  /** Optional, URL jars only: 64 hex characters. */
  sha256?: string
}

// The service's §1.2 `GET /admin/config/status` answer, passed through unchanged by Zeta.
export interface SparkConfigStatus {
  state: 'running' | 'draining' | 'restarting' | 'failed_fallback'
  epoch: number
  inflight: number
  effective: { entries: Record<string, string>; jars: string[] }
  lastError: string | null
}

// One file of the service's jars directory (its §1.2 `GET /admin/jars` answer).
export interface ServerJar {
  name: string
  sizeBytes: number
}

// The stored row of `spark_instance_configs` (schema_v7). `entries` is a JSON object and `jars` a
// JSON array of JarRef; the effective state is never stored here.
export interface SparkInstanceConfigRow {
  database_id: string
  entries: string
  jars: string
  updated_by: string | null
  updated_at: number
}

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; error: string }

// §3 limits, enforced here on save (Muse ruling).
export const INSTANCE_ENTRIES_MAX = 50
export const INSTANCE_JARS_MAX = 20
export const INSTANCE_KEY_MAX = 128
export const INSTANCE_VALUE_MAX = 512

// §6.2 entry-key rules.
const ENTRY_KEY_RE = /^spark\.[A-Za-z0-9_.]+$/
// Spark memory sizes: a number with an optional single-unit suffix (k/K/m/M/g/G/t/T), e.g. "4g".
const MEMORY_VALUE_RE = /^[0-9]+[kKmMgGtT]?$/
const URL_RE = /^https?:\/\//
const SHA256_RE = /^[0-9a-f]{64}$/
const CATALOG_RE = /^spark\.sql\.catalog\./

// §2 startup-level `spark.sql.*` static items: every other `spark.sql.*` key is a runtime key that
// belongs in a personal config profile, not in the instance config (same split as SPEC §5.2).
const STARTUP_SQL_KEYS = new Set(['spark.sql.extensions', 'spark.sql.warehouse.dir'])

function isRuntimeSqlKey(key: string): boolean {
  return key.startsWith('spark.sql.') && !STARTUP_SQL_KEYS.has(key) && !CATALOG_RE.test(key)
}

// Validates the instance `entries` (a JSON object of string → string). Rejects anything that is not
// a startup-level key, per §6.2; the frontend (#56) carries the reader-facing copy, so the errors
// here stay English and name the offending key for the log and the fallback path.
export function validateInstanceEntries(input: unknown): ValidationResult<Record<string, string>> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, error: 'entries must be an object.' }
  }
  const raw = input as Record<string, unknown>
  const keys = Object.keys(raw)
  if (keys.length > INSTANCE_ENTRIES_MAX) {
    return { ok: false, error: `At most ${INSTANCE_ENTRIES_MAX} entries are allowed.` }
  }

  const entries: Record<string, string> = {}
  for (const key of keys) {
    const value = raw[key]
    if (typeof value !== 'string') return { ok: false, error: `The value of "${key}" must be a string.` }
    if (key.length > INSTANCE_KEY_MAX) return { ok: false, error: `The key "${key}" is too long.` }
    if (!ENTRY_KEY_RE.test(key)) return { ok: false, error: `"${key}" is not a valid Spark configuration key.` }
    if (key === 'spark.jars') {
      return { ok: false, error: 'spark.jars cannot be set in entries; use the jars section instead.' }
    }
    if (isRuntimeSqlKey(key)) {
      return { ok: false, error: `"${key}" is a runtime parameter; set it in your personal connection config instead.` }
    }
    if (key.endsWith('.memory') && !MEMORY_VALUE_RE.test(value)) {
      return { ok: false, error: `The value of "${key}" must be a Spark memory size such as "4g".` }
    }
    if (value.length > INSTANCE_VALUE_MAX) return { ok: false, error: `The value of "${key}" is too long.` }
    entries[key] = value
  }
  return { ok: true, value: entries }
}

// Validates the instance `jars` (a JSON array of §1.2 elements `{type, value, sha256?}`). File
// names must not carry path separators or `..`; a URL must start with http(s) and may pin a sha256.
export function validateInstanceJars(input: unknown): ValidationResult<JarRef[]> {
  if (!Array.isArray(input)) return { ok: false, error: 'jars must be an array.' }
  if (input.length > INSTANCE_JARS_MAX) return { ok: false, error: `At most ${INSTANCE_JARS_MAX} jars are allowed.` }

  const jars: JarRef[] = []
  for (const raw of input) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      return { ok: false, error: 'Each jar must be an object with a type and a value.' }
    }
    const { type, value, sha256 } = raw as Record<string, unknown>
    if (type !== 'url' && type !== 'file') return { ok: false, error: 'Each jar needs a type of "url" or "file".' }
    if (typeof value !== 'string' || !value.trim()) return { ok: false, error: 'Each jar needs a value.' }
    const v = value.trim()

    if (type === 'url') {
      if (!URL_RE.test(v)) return { ok: false, error: 'A URL jar must start with http:// or https://.' }
      if (sha256 !== undefined) {
        if (typeof sha256 !== 'string' || !SHA256_RE.test(sha256)) {
          return { ok: false, error: 'The sha256 of a URL jar must be 64 hexadecimal characters.' }
        }
        jars.push({ type, value: v, sha256 })
      } else {
        jars.push({ type, value: v })
      }
    } else {
      if (v.includes('/') || v.includes('\\') || v.includes('..')) {
        return { ok: false, error: 'A file jar must be a file name without path separators or "..".' }
      }
      jars.push({ type, value: v })
    }
  }
  return { ok: true, value: jars }
}
