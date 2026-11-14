import { describe, it, expect } from 'vitest'
import { splitSqlStatements, stripLeadingCommentsForDisplay, usedDatabaseOf } from '../sql'

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

describe('stripLeadingCommentsForDisplay', () => {
  it('starts at the statement, dropping the comment lines above it and their blank lines', () => {
    expect(stripLeadingCommentsForDisplay('-- 取用户量\n\n\nSELECT 1')).toBe('SELECT 1')
    expect(stripLeadingCommentsForDisplay('-- 第一行\n-- 第二行\nSELECT 1')).toBe('SELECT 1')
    expect(stripLeadingCommentsForDisplay('\n\n  -- 说明\n  SELECT 1')).toBe('SELECT 1')
  })

  it("drops a block comment, whether it spans lines or sits on the statement's own line", () => {
    expect(stripLeadingCommentsForDisplay('/* 说明\n第二行 */\nSELECT 1')).toBe('SELECT 1')
    expect(stripLeadingCommentsForDisplay('/* 说明 */ SELECT 1')).toBe('SELECT 1')
  })

  it('leaves the text alone when there is nothing to strip', () => {
    expect(stripLeadingCommentsForDisplay('SELECT 1')).toBe('SELECT 1')
    expect(stripLeadingCommentsForDisplay('SELECT 1; SELECT 2')).toBe('SELECT 1; SELECT 2')
    expect(stripLeadingCommentsForDisplay('SELECT a,\n       b\nFROM t')).toBe('SELECT a,\n       b\nFROM t')
  })

  it('keeps a comment that belongs to a statement', () => {
    expect(stripLeadingCommentsForDisplay('SELECT 1 -- 只取一行')).toBe('SELECT 1 -- 只取一行')
    expect(stripLeadingCommentsForDisplay('SELECT 1\n-- 过滤条件\nFROM t')).toBe('SELECT 1\n-- 过滤条件\nFROM t')
  })

  it('never takes a comment marker inside a string or an identifier for a comment', () => {
    expect(stripLeadingCommentsForDisplay("SELECT '-- not a comment'")).toBe("SELECT '-- not a comment'")
    expect(stripLeadingCommentsForDisplay("SELECT '/* not a comment */'")).toBe("SELECT '/* not a comment */'")
    expect(stripLeadingCommentsForDisplay("SELECT 'a;-- b' FROM t")).toBe("SELECT 'a;-- b' FROM t")
    expect(stripLeadingCommentsForDisplay('SELECT "--" FROM t')).toBe('SELECT "--" FROM t')
    expect(stripLeadingCommentsForDisplay('SELECT `--` FROM t')).toBe('SELECT `--` FROM t')
  })

  it('strips the comments in front of every statement of a batch', () => {
    expect(stripLeadingCommentsForDisplay('-- 用户量\nSELECT 1;\n\n-- 订单量\nSELECT 2;')).toBe('SELECT 1;\nSELECT 2;')
    expect(stripLeadingCommentsForDisplay('SELECT 1;\n/* 订单量 */ SELECT 2')).toBe('SELECT 1;\nSELECT 2')
    expect(stripLeadingCommentsForDisplay('SELECT 1;\n-- 尾注')).toBe('SELECT 1;')
  })

  it('falls back to the stored text when nothing but comments is left', () => {
    expect(stripLeadingCommentsForDisplay('-- 只有注释')).toBe('-- 只有注释')
    expect(stripLeadingCommentsForDisplay('/* 只有注释 */')).toBe('/* 只有注释 */')
    expect(stripLeadingCommentsForDisplay('-- a\n/* b */\n')).toBe('-- a\n/* b */\n')
    expect(stripLeadingCommentsForDisplay('/* 没有闭合')).toBe('/* 没有闭合')
    expect(stripLeadingCommentsForDisplay('')).toBe('')
  })

  it('reads a leading # as MySQL writes its comments, and a # inside a statement as text', () => {
    expect(stripLeadingCommentsForDisplay('# 说明\nSELECT 1')).toBe('SELECT 1')
    expect(stripLeadingCommentsForDisplay('SELECT a # b;\n-- 下一条\nSELECT 2')).toBe('SELECT a # b;\nSELECT 2')
  })
})

describe('usedDatabaseOf', () => {
  it('reads the database a USE points the session at', () => {
    expect(usedDatabaseOf('USE app')).toBe('app')
    expect(usedDatabaseOf('use app')).toBe('app')
    expect(usedDatabaseOf('  USE   reporting  ')).toBe('reporting')
    expect(usedDatabaseOf('USE app;')).toBe('app')
  })

  it('unquotes the identifier the way MySQL quotes it', () => {
    expect(usedDatabaseOf('USE `my db`')).toBe('my db')
    expect(usedDatabaseOf('USE "MyDb"')).toBe('MyDb')
    expect(usedDatabaseOf('USE `a``b`')).toBe('a`b')
  })

  it('ignores leading comments', () => {
    expect(usedDatabaseOf('-- where to\nUSE app')).toBe('app')
    expect(usedDatabaseOf('/* switch */ USE app')).toBe('app')
    expect(usedDatabaseOf('/* unterminated USE app')).toBe(null)
  })

  it('is not fooled by anything that merely starts with those letters', () => {
    expect(usedDatabaseOf('USERS')).toBe(null)
    expect(usedDatabaseOf('SELECT 1')).toBe(null)
    expect(usedDatabaseOf("SELECT 'use x'")).toBe(null)
    expect(usedDatabaseOf('USE')).toBe(null)
    expect(usedDatabaseOf('USE app extra')).toBe(null)
    expect(usedDatabaseOf('USE `app` extra')).toBe(null)
    expect(usedDatabaseOf('')).toBe(null)
  })
})
