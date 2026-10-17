import { describe, it, expect } from 'vitest'
import { classifySql, checkSqlAccess, type SqlClass } from '../sql-guard'

const ctes = (n: number) => Array.from({ length: n }, (_, i) => `c${i} AS (SELECT ${i})`).join(', ')

describe('classifySql', () => {
  const cases: Array<[string, string, SqlClass]> = [
    ['select', 'SELECT * FROM t', 'read'],
    ['select with trailing semicolon', 'SELECT 1;', 'read'],
    ['leading comments', '-- hi\n/* x */ SELECT 1', 'read'],
    ['values', 'VALUES (1), (2)', 'read'],
    ['explain', 'EXPLAIN QUERY PLAN SELECT 1', 'read'],
    ['keyword inside string', "SELECT 'DELETE FROM t; DROP TABLE t'", 'read'],
    ['keyword inside comment', 'SELECT 1 -- ; DELETE FROM t', 'read'],
    ['read-only pragma', 'PRAGMA table_info(users)', 'read'],
    ['schema-qualified read pragma', 'PRAGMA main.table_info(users)', 'read'],
    ['cte select', 'WITH a AS (SELECT 1) SELECT * FROM a', 'read'],
    ['recursive cte', 'WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM r WHERE n<5) SELECT n FROM r', 'read'],
    ['cte using replace() function', "WITH a AS (SELECT replace('a','b','c') x) SELECT x FROM a", 'read'],
    ['cte named like write keyword in quotes', 'WITH "delete" AS (SELECT 1) SELECT * FROM "delete"', 'read'],

    ['insert', 'INSERT INTO t VALUES (1)', 'write'],
    ['update', 'UPDATE t SET a = 1', 'write'],
    ['delete', 'DELETE FROM t', 'write'],
    ['create', 'CREATE TABLE t (a)', 'write'],
    ['replace into', 'REPLACE INTO t VALUES (1)', 'write'],
    ['vacuum', 'VACUUM', 'write'],
    ['reindex', 'REINDEX', 'write'],
    ['analyze', 'ANALYZE', 'write'],
    ['begin', 'BEGIN', 'write'],
    ['alter add', 'ALTER TABLE t ADD COLUMN b', 'write'],
    ['cte + delete', 'WITH a AS (SELECT 1) DELETE FROM t', 'write'],
    ['cte + insert', 'WITH a AS (SELECT 1) INSERT INTO t SELECT * FROM a', 'write'],
    ['cte + update', 'WITH a AS (SELECT 1) UPDATE t SET x = 1', 'write'],
    ['20 ctes + delete', `WITH ${ctes(20)} DELETE FROM t`, 'write'],
    ['21 ctes + delete', `WITH ${ctes(21)} DELETE FROM t`, 'write'],
    ['200 ctes + delete', `WITH ${ctes(200)} DELETE FROM t`, 'write'],
    ['backtick cte name with paren + delete', 'WITH `a(` AS (SELECT 1) DELETE FROM t', 'write'],
    ['bracket cte name with paren + delete', 'WITH [a(] AS (SELECT 1) DELETE FROM t', 'write'],
    ['string containing paren + delete', "WITH a AS (SELECT ')') DELETE FROM t", 'write'],
    ['cte with only comments after', 'WITH a AS (SELECT 1)', 'write'],
    ['unknown leading token', '(SELECT 1)', 'write'],
    ['garbage', '@@@', 'write'],

    ['drop', 'DROP TABLE t', 'destructive'],
    ['truncate', 'TRUNCATE t', 'destructive'],
    ['comment before drop', '/* x */ -- y\nDROP TABLE t', 'destructive'],
    ['alter drop column', 'ALTER TABLE t DROP COLUMN a', 'destructive'],

    ['pragma set', 'PRAGMA foreign_keys = 0', 'forbidden'],
    ['pragma function form', 'PRAGMA foreign_keys(0)', 'forbidden'],
    ['schema-qualified pragma set', 'PRAGMA main.writable_schema = 1', 'forbidden'],
    ['unknown pragma', 'PRAGMA journal_mode', 'forbidden'],
    ['attach database', "ATTACH DATABASE 'x' AS y", 'forbidden'],
    ['attach without database keyword', "ATTACH 'x' AS y", 'forbidden'],
    ['detach', 'DETACH y', 'forbidden'],

    ['two statements', 'SELECT 1; DELETE FROM t', 'multiple'],
    ['two writes', 'DELETE FROM a; DELETE FROM b', 'multiple'],
    ['semicolon in string is fine', "SELECT 'a;b'", 'read'],

    ['empty', '', 'empty'],
    ['only comment', '-- nothing', 'empty'],
    ['only semicolons', ';;', 'empty'],
  ]

  for (const [name, sql, expected] of cases) {
    it(`${name} -> ${expected}`, () => {
      expect(classifySql(sql)).toBe(expected)
    })
  }
})

describe('checkSqlAccess', () => {
  it('lets read users run reads', () => {
    expect(checkSqlAccess('read', 'read')).toBeNull()
  })
  it('blocks read users from writes and destructive statements', () => {
    expect(checkSqlAccess('write', 'read')).toMatch(/read access/)
    expect(checkSqlAccess('destructive', 'read')).toMatch(/elevated/)
  })
  it('blocks write users from destructive statements', () => {
    expect(checkSqlAccess('write', 'write')).toBeNull()
    expect(checkSqlAccess('destructive', 'write')).toMatch(/elevated/)
  })
  it('lets write_drop run everything except forbidden', () => {
    expect(checkSqlAccess('destructive', 'write_drop')).toBeNull()
    expect(checkSqlAccess('forbidden', 'write_drop')).toMatch(/not allowed/)
  })
  it('rejects multiple statements and empty SQL for everyone', () => {
    expect(checkSqlAccess('multiple', 'write_drop')).not.toBeNull()
    expect(checkSqlAccess('empty', 'write_drop')).not.toBeNull()
  })
})
