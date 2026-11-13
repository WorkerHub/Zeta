import { describe, it, expect } from 'vitest'
import { effectiveProvider, engineLabelKey } from '../db-provider'

describe('effectiveProvider', () => {
  it("uses the registration's own text when it has one", () => {
    expect(effectiveProvider('postgres', 'Aiven')).toBe('Aiven')
    expect(effectiveProvider('spark', 'Instabox')).toBe('Instabox')
    // It wins over the derived value, whatever the engine
    expect(effectiveProvider('mysql', 'PlanetScale')).toBe('PlanetScale')
  })

  it('falls back to the provider each engine is registered on', () => {
    expect(effectiveProvider('sqlite')).toBe('D1')
    expect(effectiveProvider('postgres')).toBe('Neon')
    expect(effectiveProvider('mysql')).toBe('TiDB')
  })

  it('has nothing for Spark, and D1 for rows written before the kind column', () => {
    expect(effectiveProvider('spark')).toBe(null)
    expect(effectiveProvider(undefined)).toBe('D1')
    expect(effectiveProvider(undefined, '')).toBe('D1')
  })

  it('treats blank text as no text', () => {
    expect(effectiveProvider('sqlite', '')).toBe('D1')
    expect(effectiveProvider('postgres', '   ')).toBe('Neon')
    expect(effectiveProvider('spark', '  ')).toBe(null)
    expect(effectiveProvider('postgres', '  Aiven  ')).toBe('Aiven')
  })
})

describe('engineLabelKey', () => {
  it('names every engine the way the switcher does', () => {
    expect(engineLabelKey('sqlite')).toBe('query.kind_sqlite')
    expect(engineLabelKey('postgres')).toBe('admin_db.kind_postgres')
    expect(engineLabelKey('mysql')).toBe('admin_db.kind_mysql')
    expect(engineLabelKey('spark')).toBe('admin_db.kind_spark')
    expect(engineLabelKey(undefined)).toBe('query.kind_sqlite')
  })
})
