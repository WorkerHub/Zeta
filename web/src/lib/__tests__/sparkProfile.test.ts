import { describe, it, expect } from 'vitest'
import {
  connectedProfileOf,
  forgetConnectedProfile,
  forgetSelectedProfile,
  isStartupLevelKey,
  needsReconnect,
  parseProfileMap,
  rememberConnectedProfile,
  rememberSelectedProfile,
  selectedProfileOf,
  validateProfileEntry,
} from '../spark-profile'

describe('isStartupLevelKey', () => {
  it('names the startup-level static keys a profile must refuse', () => {
    expect(isStartupLevelKey('spark.sql.extensions')).toBe(true)
    expect(isStartupLevelKey('spark.sql.warehouse.dir')).toBe(true)
    expect(isStartupLevelKey('spark.sql.catalog.impl')).toBe(true)
    expect(isStartupLevelKey('spark.sql.shuffle.partitions')).toBe(false)
  })
})

describe('validateProfileEntry', () => {
  it('passes a runtime spark.sql.* key', () => {
    expect(validateProfileEntry('spark.sql.shuffle.partitions', '200')).toBeNull()
    expect(validateProfileEntry(' spark.sql.adaptive.enabled ', ' true ')).toBeNull()
  })

  it('ignores a blank line (both empty)', () => {
    expect(validateProfileEntry('', '')).toBeNull()
    expect(validateProfileEntry('   ', '  ')).toBeNull()
  })

  it('refuses an empty key or value', () => {
    expect(validateProfileEntry('', '200')).toMatchObject({ code: 'invalid_key' })
    expect(validateProfileEntry('spark.sql.foo', '')).toMatchObject({ code: 'invalid_key' })
  })

  it('refuses startup-level keys with the startup code and the key named', () => {
    expect(validateProfileEntry('spark.sql.extensions', 'x')).toMatchObject({
      code: 'startup_key_in_profile',
      key: 'spark.sql.extensions',
    })
    expect(validateProfileEntry('spark.driver.memory', '4g')).toMatchObject({
      code: 'startup_key_in_profile',
      key: 'spark.driver.memory',
    })
  })

  it('refuses a key outside spark.* entirely', () => {
    expect(validateProfileEntry('foo.bar', 'x')).toMatchObject({ code: 'invalid_key', key: 'foo.bar' })
  })
})

describe('per-target profile maps', () => {
  it('parses only non-empty string pairs, defensively', () => {
    expect(parseProfileMap(null)).toEqual({})
    expect(parseProfileMap('not json')).toEqual({})
    expect(parseProfileMap('[1,2]')).toEqual({})
    expect(parseProfileMap('{"a":"p1","b":5,"c":""}')).toEqual({ a: 'p1' })
  })

  it('remembers, clears and forgets a selection', () => {
    const map = rememberSelectedProfile({}, 'db1', 'p1')
    expect(selectedProfileOf(map, 'db1')).toBe('p1')
    expect(selectedProfileOf(map, 'nope')).toBeNull()
    expect(selectedProfileOf(forgetSelectedProfile(map, 'db1'), 'db1')).toBeNull()
    // A null profile id is the default configuration: it clears the entry.
    expect(selectedProfileOf(rememberSelectedProfile(map, 'db1', null), 'db1')).toBeNull()
  })

  it('tracks the profile a connection was made with, separately', () => {
    const connected = rememberConnectedProfile({}, 'db1', 'p2')
    expect(connectedProfileOf(connected, 'db1')).toBe('p2')
    expect(connectedProfileOf(forgetConnectedProfile(connected, 'db1'), 'db1')).toBeNull()
  })
})

describe('needsReconnect', () => {
  it('is false when disconnected or when the selection is unchanged', () => {
    expect(needsReconnect(false, 'p1', 'p1')).toBe(false)
    expect(needsReconnect(true, null, null)).toBe(false)
    expect(needsReconnect(true, 'p1', 'p1')).toBe(false)
  })

  it('is true when connected and the selection moved off the connected profile', () => {
    expect(needsReconnect(true, 'p1', null)).toBe(true)
    expect(needsReconnect(true, null, 'p1')).toBe(true)
    expect(needsReconnect(true, 'p2', 'p1')).toBe(true)
  })
})
