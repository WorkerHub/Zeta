import { describe, it, expect } from 'vitest'
import { missingSessionDatabase, namesUnknownDatabase } from '../session-database'

// What the worker sends back when a session is pinned at a database that does not exist
const PIN_FAILURE = "Execute SQL fail: Error 1049 (42000): Unknown database 'ghost_db'"

describe('namesUnknownDatabase', () => {
  it('recognises the engine sentence for a missing database', () => {
    expect(namesUnknownDatabase(PIN_FAILURE)).toBe(true)
    expect(namesUnknownDatabase('Error 1049 (42000): Unknown database')).toBe(true)
  })

  it('leaves every other failure alone', () => {
    expect(namesUnknownDatabase("You have an error in your SQL syntax: near 'x'")).toBe(false)
    expect(namesUnknownDatabase('Error 1146 (42S02): Table x does not exist')).toBe(false)
    expect(namesUnknownDatabase('Authentication failed')).toBe(false)
  })
})

describe('missingSessionDatabase', () => {
  it('forgets the database when a statement that is not a USE fails on the pin', () => {
    expect(missingSessionDatabase({ statement: 'SELECT DATABASE()', message: PIN_FAILURE })).toBe(true)
  })

  it('keeps it when the failing statement is the USE itself — a rejected USE changes nothing', () => {
    expect(missingSessionDatabase({ statement: 'USE ghost_db', message: PIN_FAILURE })).toBe(false)
  })

  it('forgets it for a failed batch request, which can only be the pin', () => {
    expect(missingSessionDatabase({ message: PIN_FAILURE })).toBe(true)
  })

  it('has nothing to say about other failures', () => {
    expect(missingSessionDatabase({ statement: 'SELECT 1', message: 'Database configuration error.' })).toBe(false)
    expect(missingSessionDatabase({ message: 'Could not reach the database: timeout' })).toBe(false)
  })
})
