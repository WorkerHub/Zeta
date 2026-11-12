import { describe, expect, it } from 'vitest'
import { toJsonSafe, toJsonSafeRows } from '../json-safe'

describe('toJsonSafe', () => {
  it('turns bigint into a decimal string and keeps numbers', () => {
    expect(toJsonSafe(123n)).toBe('123')
    expect(toJsonSafe(-9223372036854775807n)).toBe('-9223372036854775807')
    expect(toJsonSafe(42)).toBe(42)
    expect(toJsonSafe(1.5)).toBe(1.5)
  })

  it('turns dates into ISO strings', () => {
    expect(toJsonSafe(new Date('2026-11-12T15:39:41.123Z'))).toBe('2026-11-12T15:39:41.123Z')
    expect(toJsonSafe(new Date(Number.NaN))).toBeNull()
  })

  it('turns binary into base64', () => {
    expect(toJsonSafe(new Uint8Array([1, 2, 3]))).toBe('AQID')
    expect(toJsonSafe(new TextEncoder().encode('zeta'))).toBe(btoa('zeta'))
    expect(toJsonSafe(new Uint8Array([]).buffer)).toBe('')
  })

  it('base64-encodes a large value without overflowing the call stack', () => {
    const bytes = new Uint8Array(200_000).fill(7)
    expect(toJsonSafe(bytes)).toBe(btoa('\x07'.repeat(200_000)))
  })

  it('walks arrays and json objects recursively', () => {
    expect(
      toJsonSafe({
        id: 1n,
        at: new Date('2026-01-02T03:04:05.000Z'),
        tags: ['a', 2n],
        nested: { blob: new Uint8Array([255]) },
        missing: undefined,
        nothing: null,
      })
    ).toEqual({
      id: '1',
      at: '2026-01-02T03:04:05.000Z',
      tags: ['a', '2'],
      nested: { blob: '/w==' },
      missing: null,
      nothing: null,
    })
  })

  it('keeps non-finite floats readable instead of nulling them', () => {
    expect(toJsonSafe(Number.NaN)).toBe('NaN')
    expect(toJsonSafe(Number.POSITIVE_INFINITY)).toBe('Infinity')
    expect(toJsonSafe(Number.NEGATIVE_INFINITY)).toBe('-Infinity')
  })

  it('maps whole rows and survives JSON.stringify', () => {
    const rows = toJsonSafeRows([
      { n: 10n, at: new Date('2026-11-12T00:00:00.000Z'), blob: new Uint8Array([104, 105]) },
    ])
    expect(JSON.parse(JSON.stringify(rows))).toEqual([{ n: '10', at: '2026-11-12T00:00:00.000Z', blob: 'aGk=' }])
  })
})
