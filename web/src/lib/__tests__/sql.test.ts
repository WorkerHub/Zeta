import { describe, it, expect } from 'vitest'
import { splitSqlStatements } from '../sql'

describe('splitSqlStatements', () => {
  it('returns empty array for empty string', () => {
    expect(splitSqlStatements('')).toEqual([])
  })

  it('returns empty array for whitespace-only string', () => {
    expect(splitSqlStatements('   \n\t  ')).toEqual([])
  })

  it('splits two simple statements', () => {
    expect(splitSqlStatements('SELECT 1; SELECT 2')).toEqual(['SELECT 1', 'SELECT 2'])
  })

  it('handles trailing semicolon (no empty statement at end)', () => {
    expect(splitSqlStatements('SELECT 1;')).toEqual(['SELECT 1'])
  })

  it('returns single statement with no semicolon', () => {
    expect(splitSqlStatements('SELECT * FROM users')).toEqual(['SELECT * FROM users'])
  })

  it('does not split on semicolon inside single-quoted string', () => {
    expect(splitSqlStatements("SELECT 'a;b' FROM t")).toEqual(["SELECT 'a;b' FROM t"])
  })

  it('handles escaped single quote inside string (two consecutive single quotes)', () => {
    expect(splitSqlStatements("SELECT 'it''s'; SELECT 2")).toEqual(["SELECT 'it''s'", 'SELECT 2'])
  })

  it('does not split on semicolon inside line comment', () => {
    expect(splitSqlStatements('SELECT 1 -- comment;\nFROM t')).toEqual(['SELECT 1 -- comment;\nFROM t'])
  })

  it('does not split on semicolon inside block comment', () => {
    expect(splitSqlStatements('SELECT /* a;b */ 1')).toEqual(['SELECT /* a;b */ 1'])
  })

  it('filters out whitespace-only statements between semicolons', () => {
    expect(splitSqlStatements('SELECT 1;;SELECT 2')).toEqual(['SELECT 1', 'SELECT 2'])
  })

  it('trims whitespace from each statement', () => {
    expect(splitSqlStatements('  SELECT 1  ;  SELECT 2  ')).toEqual(['SELECT 1', 'SELECT 2'])
  })

  it('handles multiple statements across newlines', () => {
    const sql = `
      SELECT * FROM users;
      INSERT INTO logs (msg) VALUES ('hello');
      SELECT count(*) FROM logs
    `
    const result = splitSqlStatements(sql)
    expect(result).toHaveLength(3)
    expect(result[0]).toBe('SELECT * FROM users')
    expect(result[1]).toBe("INSERT INTO logs (msg) VALUES ('hello')")
    expect(result[2]).toBe('SELECT count(*) FROM logs')
  })
})
