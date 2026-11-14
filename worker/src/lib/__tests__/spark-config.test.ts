import { describe, expect, it } from 'vitest'
import {
  INSTANCE_ENTRIES_MAX,
  INSTANCE_JARS_MAX,
  INSTANCE_KEY_MAX,
  INSTANCE_VALUE_MAX,
  validateInstanceEntries,
  validateInstanceJars,
} from '../spark-config'

describe('validateInstanceEntries', () => {
  it('accepts a startup-level entry', () => {
    const r = validateInstanceEntries({ 'spark.driver.memory': '4g', 'spark.executor.cores': '2' })
    expect(r).toEqual({ ok: true, value: { 'spark.driver.memory': '4g', 'spark.executor.cores': '2' } })
  })

  it('accepts the §2 startup-level spark.sql.* static items', () => {
    for (const key of ['spark.sql.extensions', 'spark.sql.warehouse.dir', 'spark.sql.catalog.iceberg']) {
      const r = validateInstanceEntries({ [key]: 'x' })
      expect(r.ok, key).toBe(true)
    }
  })

  it('rejects non-objects and arrays', () => {
    expect(validateInstanceEntries(null).ok).toBe(false)
    expect(validateInstanceEntries(undefined).ok).toBe(false)
    expect(validateInstanceEntries([]).ok).toBe(false)
    expect(validateInstanceEntries('x').ok).toBe(false)
  })

  it('rejects non-string values', () => {
    expect(validateInstanceEntries({ 'spark.driver.memory': 4 }).ok).toBe(false)
  })

  it('rejects keys that do not match the spark.* shape', () => {
    for (const key of ['driver.memory', 'spark driver.memory', 'spark.driver-memory', 'spark.']) {
      expect(validateInstanceEntries({ [key]: '1' }).ok, key).toBe(false)
    }
  })

  it('rejects spark.jars in entries', () => {
    const r = validateInstanceEntries({ 'spark.jars': 'a.jar' })
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining('jars') })
  })

  it('rejects a runtime spark.sql.* key', () => {
    const r = validateInstanceEntries({ 'spark.sql.shuffle.partitions': '1000' })
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining('runtime parameter') })
  })

  it('rejects bad memory values and accepts good ones', () => {
    for (const bad of ['g', '4gg', '4 g', '', '1.5g', '-1']) {
      expect(validateInstanceEntries({ 'spark.driver.memory': bad }).ok, JSON.stringify(bad)).toBe(false)
    }
    for (const good of ['4g', '4G', '4096', '1k', '2M', '3t']) {
      expect(validateInstanceEntries({ 'spark.driver.memory': good }).ok, good).toBe(true)
    }
  })

  it('only checks memory values for .memory keys', () => {
    expect(validateInstanceEntries({ 'spark.executor.cores': 'not-a-number' }).ok).toBe(true)
  })

  it('enforces key and value length limits', () => {
    expect(validateInstanceEntries({ [`spark.${'a'.repeat(INSTANCE_KEY_MAX)}`]: '1' }).ok).toBe(false)
    expect(validateInstanceEntries({ 'spark.driver.memory': 'a'.repeat(INSTANCE_VALUE_MAX + 1) }).ok).toBe(false)
  })

  it('enforces the entry count limit', () => {
    const entries: Record<string, string> = {}
    for (let i = 0; i < INSTANCE_ENTRIES_MAX + 1; i++) entries[`spark.k${i}`] = '1'
    expect(validateInstanceEntries(entries).ok).toBe(false)
    delete entries[`spark.k${INSTANCE_ENTRIES_MAX}`]
    expect(validateInstanceEntries(entries).ok).toBe(true)
  })
})

describe('validateInstanceJars', () => {
  it('accepts url and file jars', () => {
    const r = validateInstanceJars([
      { type: 'url', value: 'https://example.com/delta.jar', sha256: 'a'.repeat(64) },
      { type: 'file', value: 'my-udf.jar' },
    ])
    expect(r).toEqual({
      ok: true,
      value: [
        { type: 'url', value: 'https://example.com/delta.jar', sha256: 'a'.repeat(64) },
        { type: 'file', value: 'my-udf.jar' },
      ],
    })
  })

  it('accepts a url without a sha256 and trims the value', () => {
    const r = validateInstanceJars([{ type: 'url', value: '  https://example.com/x.jar  ' }])
    expect(r).toEqual({ ok: true, value: [{ type: 'url', value: 'https://example.com/x.jar' }] })
  })

  it('rejects a non-array', () => {
    expect(validateInstanceJars({}).ok).toBe(false)
    expect(validateInstanceJars(null).ok).toBe(false)
  })

  it('rejects a bad type or a non-object element', () => {
    expect(validateInstanceJars([{ type: 'ftp', value: 'x.jar' }]).ok).toBe(false)
    expect(validateInstanceJars(['x.jar']).ok).toBe(false)
  })

  it('rejects an empty value', () => {
    expect(validateInstanceJars([{ type: 'file', value: '  ' }]).ok).toBe(false)
  })

  it('rejects a url that does not start with http(s)', () => {
    expect(validateInstanceJars([{ type: 'url', value: 'file:///x.jar' }]).ok).toBe(false)
  })

  it('rejects a bad sha256', () => {
    expect(validateInstanceJars([{ type: 'url', value: 'https://x.jar', sha256: 'zz' }]).ok).toBe(false)
    expect(validateInstanceJars([{ type: 'url', value: 'https://x.jar', sha256: 'A'.repeat(64) }]).ok).toBe(false)
  })

  it('rejects file names with path separators or ..', () => {
    for (const value of ['a/b.jar', 'a\\b.jar', '../a.jar', 'a/../b.jar']) {
      expect(validateInstanceJars([{ type: 'file', value }]).ok, value).toBe(false)
    }
  })

  it('enforces the jar count limit', () => {
    const jars = Array.from({ length: INSTANCE_JARS_MAX }, (_, i) => ({ type: 'file' as const, value: `j${i}.jar` }))
    expect(validateInstanceJars(jars).ok).toBe(true)
    expect(validateInstanceJars([...jars, { type: 'file', value: 'extra.jar' }]).ok).toBe(false)
  })
})
