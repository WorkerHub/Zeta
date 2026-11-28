// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest'
import {
  LIVY_SESSIONS_KEY,
  forgetLivySession,
  parseSessionMap,
  readLivySession,
  rememberLivySession,
  sessionKey,
} from '../livy-session'

describe('livy-session', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('computes sessionKey accurately', () => {
    expect(sessionKey('u1', 'db1')).toBe('u1:db1')
  })

  it('parses null or invalid JSON gracefully', () => {
    expect(parseSessionMap(null)).toEqual({})
    expect(parseSessionMap('')).toEqual({})
    expect(parseSessionMap('{invalid')).toEqual({})
    expect(parseSessionMap('[]')).toEqual({})
    expect(parseSessionMap('"string"')).toEqual({})
  })

  it('parses valid session maps while ignoring malformed entries', () => {
    const raw = JSON.stringify({
      'u1:db1': { sessionId: 12, kind: 'spark' },
      'u1:db2': { sessionId: 99, kind: 'pyspark' },
      'bad:entry': { sessionId: 'not-a-number', kind: 'sql' },
      'bad:entry2': { kind: 'sql' },
      'bad:kind': { sessionId: 88, kind: 'unsupported' },
    })
    expect(parseSessionMap(raw)).toEqual({
      'u1:db1': { sessionId: 12, kind: 'spark' },
      'u1:db2': { sessionId: 99, kind: 'pyspark' },
    })
  })

  it('reads, remembers, and forgets sessions by (userId x databaseId)', () => {
    expect(readLivySession('u1', 'db1')).toBe(null)

    rememberLivySession('u1', 'db1', { sessionId: 42, kind: 'sql' })
    expect(readLivySession('u1', 'db1')).toEqual({ sessionId: 42, kind: 'sql' })
    expect(readLivySession('u2', 'db1')).toBe(null)
    expect(readLivySession('u1', 'db2')).toBe(null)

    rememberLivySession('u2', 'db1', { sessionId: 88, kind: 'pyspark' })
    expect(readLivySession('u2', 'db1')).toEqual({ sessionId: 88, kind: 'pyspark' })

    forgetLivySession('u1', 'db1')
    expect(readLivySession('u1', 'db1')).toBe(null)
    expect(readLivySession('u2', 'db1')).toEqual({ sessionId: 88, kind: 'pyspark' })
  })

  it('ignores empty userId or databaseId', () => {
    rememberLivySession('', 'db1', { sessionId: 1, kind: 'spark' })
    expect(localStorage.getItem(LIVY_SESSIONS_KEY)).toBe(null)
    expect(readLivySession('', 'db1')).toBe(null)
  })
})
