import type { DatabaseKind } from '../types'

// ── Provider (display-only) ───────────────────────────────────────────────────────────────────
// Every engine Zeta registers runs on exactly one provider, and a registration may name its own
// instead (an Aiven PostgreSQL, a compatible endpoint, …). The value is a label for the panel: no
// executor, permission check or query path may branch on it, and it never changes what runs where.

export const PROVIDER_MAX_LENGTH = 40

// The provider an engine runs on when the registration names none. Spark has no managed provider, so
// a Spark target without a custom value shows none at all.
const DERIVED_PROVIDER: Record<DatabaseKind, string | null> = {
  sqlite: 'D1',
  postgres: 'Neon',
  mysql: 'TiDB',
  spark: null,
}

export type ProviderField = { ok: true; value: string | null } | { ok: false; error: string }

// Validates the `provider` field of a registration or edit request. Absent, null and a blank string
// all mean "no custom value" — the row then shows the derived one. Anything past the limit is
// refused instead of truncated, so what the admin typed is what the panel shows.
export function normalizeProvider(value: unknown): ProviderField {
  if (value === undefined || value === null) return { ok: true, value: null }
  if (typeof value !== 'string') return { ok: false, error: 'provider must be a string' }
  const trimmed = value.trim()
  if (!trimmed) return { ok: true, value: null }
  if (trimmed.length > PROVIDER_MAX_LENGTH) {
    return { ok: false, error: `provider must be ${PROVIDER_MAX_LENGTH} characters or fewer` }
  }
  return { ok: true, value: trimmed }
}

// The provider a caller shows: the registration's own text when it has one, otherwise the engine's.
// A row registered before the kind column existed is a SQLite target (see lib/bindings.ts).
export function effectiveProvider(
  kind: DatabaseKind | null | undefined,
  custom: string | null | undefined
): string | null {
  if (custom) return custom
  return DERIVED_PROVIDER[kind ?? 'sqlite'] ?? null
}
