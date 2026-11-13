import { describe, it, expect } from 'vitest'
import { addConnected, knocksBack, parseConnected, removeConnected, serializeConnected } from '../connection-state'

describe('parseConnected', () => {
  it('reads back what serializeConnected wrote', () => {
    expect(parseConnected(serializeConnected(['a', 'b']))).toEqual(['a', 'b'])
  })

  it('treats a missing or unreadable value as empty', () => {
    expect(parseConnected(null)).toEqual([])
    expect(parseConnected('')).toEqual([])
    expect(parseConnected('not json')).toEqual([])
    expect(parseConnected('{"id":"a"}')).toEqual([])
    expect(parseConnected('null')).toEqual([])
  })

  it('drops anything that is not a non-empty string, and collapses duplicates', () => {
    expect(parseConnected('["a",1,null,"","a","b"]')).toEqual(['a', 'b'])
  })
})

describe('addConnected / removeConnected', () => {
  it('adds a target once', () => {
    expect(addConnected([], 'a')).toEqual(['a'])
    expect(addConnected(['a'], 'a')).toEqual(['a'])
  })

  it('removes only the target it names', () => {
    expect(removeConnected(['a', 'b'], 'a')).toEqual(['b'])
    expect(removeConnected(['a'], 'zz')).toEqual(['a'])
  })

  it('never mutates the list it was given', () => {
    const ids = ['a']
    addConnected(ids, 'b')
    removeConnected(ids, 'a')
    expect(ids).toEqual(['a'])
  })
})

describe('knocksBack', () => {
  it('treats a 5xx failure as "this target is not reachable any more"', () => {
    expect(knocksBack(500)).toBe(true)
    expect(knocksBack(503)).toBe(true)
  })

  it('leaves the connection alone for a rejected statement or a missing status', () => {
    expect(knocksBack(400)).toBe(false)
    expect(knocksBack(403)).toBe(false)
    expect(knocksBack(429)).toBe(false)
    expect(knocksBack(undefined)).toBe(false)
  })
})
