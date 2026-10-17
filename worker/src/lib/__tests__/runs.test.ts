import { describe, it, expect } from 'vitest'
import { packRunResults, parseBoundedInt, runPolicy, type RunStatement } from '../runs'

const rows = (n: number, width = 10) => Array.from({ length: n }, (_, i) => ({ i, v: 'x'.repeat(width) }))
const bytes = (s: string) => new TextEncoder().encode(s).length

describe('packRunResults', () => {
  it('stores small results unchanged', () => {
    const statements: RunStatement[] = [
      { sql: 'SELECT 1', results: rows(3), duration_ms: 2 },
      { sql: 'UPDATE t SET x = 1', results: [], duration_ms: 1, changes: 4 },
      { sql: 'SELECT nope', results: [], duration_ms: 0, error: 'no such column' },
    ]
    const packed = packRunResults(statements)
    expect(JSON.parse(packed.json)).toEqual(statements)
    expect(packed.bytes).toBe(bytes(packed.json))
    expect(packed).toMatchObject({ rowCount: 3, errorCount: 1, storageTruncated: false })
  })

  it('keeps rows in order until the byte budget runs out and marks what was cut', () => {
    const statements: RunStatement[] = [
      { sql: 'SELECT a', results: rows(50, 100), duration_ms: 1 },
      { sql: 'SELECT b', results: rows(50, 100), duration_ms: 1, truncated: true },
    ]
    const packed = packRunResults(statements, 4_000)
    const stored = JSON.parse(packed.json) as RunStatement[]
    expect(packed.bytes).toBeLessThanOrEqual(4_000)
    expect(packed.storageTruncated).toBe(true)
    expect(stored[0]!.stored_rows).toBe(stored[0]!.results.length)
    expect(stored[0]!.results.length).toBeGreaterThan(0)
    expect(stored[0]!.results.length).toBeLessThan(50)
    expect(stored[0]!.results).toEqual(statements[0]!.results.slice(0, stored[0]!.results.length))
    expect(stored[1]).toMatchObject({ results: [], stored_rows: 0, truncated: true })
    // The row count reflects what the query returned, not what was stored
    expect(packed.rowCount).toBe(100)
  })

  it('shortens long statement texts when they alone would not fit', () => {
    const statements = Array.from({ length: 100 }, () => ({ sql: 'S'.repeat(10_000), results: [], duration_ms: 0 }))
    const packed = packRunResults(statements)
    expect(packed.bytes).toBeLessThanOrEqual(512 * 1024)
    expect((JSON.parse(packed.json) as RunStatement[])[0]!.sql).toHaveLength(500)
  })
})

describe('run limits', () => {
  it('parses bounded integers strictly', () => {
    expect(parseBoundedInt('100', 1, 1000)).toBe(100)
    expect(parseBoundedInt(7, 1, 10)).toBe(7)
    for (const bad of ['0', '1001', 'abc', '2.5', '-3', '', null, undefined, 2.5]) {
      expect(parseBoundedInt(bad, 1, 1000)).toBeNull()
    }
  })

  it('falls back to the defaults for missing or malformed settings', () => {
    expect(runPolicy(null, null, null)).toEqual({
      adminLimit: 100,
      userLimit: null,
      effectiveLimit: 100,
      quotaBytes: 50 * 1024 * 1024,
    })
    expect(runPolicy('5000', 'lots', 0)).toMatchObject({
      adminLimit: 100,
      userLimit: null,
      quotaBytes: 50 * 1024 * 1024,
    })
  })

  it('never lets the user limit exceed the admin limit', () => {
    expect(runPolicy('100', '50', 3).effectiveLimit).toBe(3)
    expect(runPolicy('20', '50', 300)).toMatchObject({ userLimit: 300, effectiveLimit: 20 })
    expect(runPolicy('20', '2', null)).toMatchObject({ effectiveLimit: 20, quotaBytes: 2 * 1024 * 1024 })
  })
})
