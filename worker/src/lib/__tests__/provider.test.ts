import { describe, expect, it } from 'vitest'
import { effectiveProvider, normalizeProvider, PROVIDER_MAX_LENGTH } from '../provider'

// The provider label is display-only: it is validated when it arrives and resolved when it is read,
// and nothing else in the Worker looks at it.

describe('normalizeProvider', () => {
  it('keeps a name as typed, minus surrounding blanks', () => {
    expect(normalizeProvider('  Aiven  ')).toEqual({ ok: true, value: 'Aiven' })
  })

  it('treats absent, null and blank as "no custom value"', () => {
    for (const value of [undefined, null, '', '   ', '\t\n']) {
      expect(normalizeProvider(value)).toEqual({ ok: true, value: null })
    }
  })

  it('accepts the limit exactly and refuses one character more', () => {
    const atLimit = 'p'.repeat(PROVIDER_MAX_LENGTH)
    expect(normalizeProvider(atLimit)).toEqual({ ok: true, value: atLimit })
    const overLimit = 'p'.repeat(PROVIDER_MAX_LENGTH + 1)
    const refused = normalizeProvider(overLimit)
    expect(refused.ok).toBe(false)
    expect(!refused.ok && refused.error).toBe('provider must be 40 characters or fewer')
  })

  it('refuses a value that is not text at all', () => {
    for (const value of [42, true, {}, ['provider']]) {
      const refused = normalizeProvider(value)
      expect(refused.ok).toBe(false)
      expect(!refused.ok && refused.error).toBe('provider must be a string')
    }
  })
})

describe('effectiveProvider', () => {
  it("derives each engine's own provider when the registration names none", () => {
    expect(effectiveProvider('sqlite', null)).toBe('D1')
    expect(effectiveProvider('postgres', null)).toBe('Neon')
    expect(effectiveProvider('mysql', null)).toBe('TiDB')
    // Spark runs on no managed provider at all
    expect(effectiveProvider('spark', null)).toBeNull()
  })

  it('prefers the custom value, whatever the engine', () => {
    expect(effectiveProvider('postgres', 'Aiven')).toBe('Aiven')
    expect(effectiveProvider('mysql', 'PlanetScale')).toBe('PlanetScale')
    expect(effectiveProvider('spark', 'EKS')).toBe('EKS')
  })

  it('treats a row from before the kind column as a SQLite target', () => {
    expect(effectiveProvider(undefined, null)).toBe('D1')
    expect(effectiveProvider(null, undefined)).toBe('D1')
  })
})
