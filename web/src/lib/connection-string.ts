// Registration form state for the engines that are proven by a live test (PostgreSQL,
// MySQL/TiDB Cloud Starter, SparkSQL).
//
// The backend tests the connection again when it stores the registration, so this is only the
// form's own gate: a passing test vouches for the exact values it ran against, and nothing else.

export type ConnectionTestState = 'idle' | 'testing' | 'passed' | 'failed'

/** The engines registered from values the user pastes, rather than from a Cloudflare database. */
export type ConnectionKind = 'postgres' | 'mysql' | 'spark'

export interface ConnectionValues {
  kind: ConnectionKind
  /** Connection string for the SQL engines, the service's publish address for Spark. */
  url: string
  /** Spark only: the publish address' platform token. */
  platformToken?: string
  /** Spark only: the service's app token. */
  appToken?: string
}

/**
 * What a passing test vouches for: the engine plus every value that went into it. Spark needs three
 * (address + two tokens); the SQL engines need only their connection string. Returns null while a
 * required value is missing, so an incomplete form can never be saved.
 */
export function connectionSignature(values: ConnectionValues): string | null {
  const url = values.url.trim()
  if (!url) return null
  if (values.kind !== 'spark') return JSON.stringify([values.kind, url])
  const platformToken = values.platformToken?.trim() ?? ''
  const appToken = values.appToken?.trim() ?? ''
  if (!platformToken || !appToken) return null
  return JSON.stringify([values.kind, url, platformToken, appToken])
}

/** Whether what is in the form right now is exactly what the last passing test ran against. */
export function canSaveConnection(signature: string | null, tested: string | null): boolean {
  return signature !== null && signature === tested
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
