// Registration form state for connection-string targets (PostgreSQL).
//
// The backend tests the connection again when it stores the registration, so this is only the
// form's own gate: a passing test vouches for the one string it ran against, and nothing else.

export type PgTestState = 'idle' | 'testing' | 'passed' | 'failed'

/** Whether the string currently in the form is the one whose test connection passed. */
export function canSavePostgres(url: string, testedUrl: string | null): boolean {
  const current = url.trim()
  return current !== '' && current === testedUrl
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
