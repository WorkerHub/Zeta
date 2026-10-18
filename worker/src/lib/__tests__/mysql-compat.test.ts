import { describe, it, expect } from 'vitest'
import { translateMySql } from '../mysql-compat'
import { classifySql } from '../sql-guard'

const sql = (input: string) => {
  const result = translateMySql(input)
  if (result?.type !== 'sql') throw new Error(`expected a rewrite, got ${JSON.stringify(result)} for ${input}`)
  return result.sql
}

describe('translateMySql', () => {
  describe('SHOW TABLES', () => {
    it('lists tables and views, excluding internal ones', () => {
      expect(sql('SHOW TABLES')).toBe(
        [
          'SELECT name',
          'FROM sqlite_master',
          "WHERE type IN ('table', 'view')",
          "AND substr(name, 1, 7) <> 'sqlite_'",
          "AND substr(name, 1, 4) <> '_cf_'",
          'ORDER BY name',
        ].join('\n')
      )
      expect(sql('show tables')).toBe(sql('SHOW TABLES'))
      expect(sql('  SHOW   TABLES  ;  ')).toBe(sql('SHOW TABLES'))
    })

    it('falls through for extra arguments', () => {
      expect(translateMySql("SHOW TABLES LIKE 'users'")).toBeNull()
      expect(translateMySql('SHOW TABLES users')).toBeNull()
    })
  })

  describe('DESCRIBE / DESC / SHOW COLUMNS', () => {
    const expected = (table: string) =>
      [
        'SELECT',
        '  p.name AS "Field",',
        '  p.type AS "Type",',
        '  CASE WHEN p."notnull" THEN \'NO\' ELSE \'YES\' END AS "Null",',
        "  CASE WHEN p.pk > 0 THEN 'PRI' ELSE '' END AS \"Key\",",
        '  p.dflt_value AS "Default",',
        '  \'\' AS "Extra"',
        `FROM pragma_table_info('${table}') AS p`,
        'ORDER BY p.cid',
      ].join('\n')

    it('rewrites DESCRIBE, DESC and SHOW COLUMNS FROM', () => {
      expect(sql('DESCRIBE users')).toBe(expected('users'))
      expect(sql('DESC users')).toBe(expected('users'))
      expect(sql('SHOW COLUMNS FROM users')).toBe(expected('users'))
      expect(sql('SHOW COLUMNS IN users')).toBe(expected('users'))
    })

    it('supports backtick, double-quoted and unquoted table names', () => {
      expect(sql('DESCRIBE `users`')).toBe(expected('users'))
      expect(sql('DESC "users"')).toBe(expected('users'))
      expect(sql('SHOW COLUMNS FROM `users`')).toBe(expected('users'))
      expect(sql('SHOW COLUMNS FROM "users"')).toBe(expected('users'))
    })

    it('unescapes doubled quotes inside quoted identifiers', () => {
      expect(sql('DESCRIBE `a``b`')).toBe(expected('a`b'))
      expect(sql('DESCRIBE "a""b"')).toBe(expected('a"b'))
    })

    it('falls through for unsupported forms', () => {
      expect(translateMySql('DESCRIBE')).toBeNull()
      expect(translateMySql("DESCRIBE 'users'")).toBeNull()
      expect(translateMySql('SHOW COLUMNS users')).toBeNull()
      expect(translateMySql('DESC users extra')).toBeNull()
    })
  })

  describe('SHOW CREATE TABLE', () => {
    it('rewrites the statement', () => {
      expect(sql('SHOW CREATE TABLE users')).toBe(
        [
          'SELECT name AS "Table", sql AS "Create Table"',
          'FROM sqlite_master',
          "WHERE type = 'table' AND name = 'users'",
        ].join('\n')
      )
      expect(sql('show create table `users`')).toBe(sql('SHOW CREATE TABLE users'))
      expect(sql('SHOW CREATE TABLE "users"')).toBe(sql('SHOW CREATE TABLE users'))
    })

    it('falls through for unsupported forms', () => {
      expect(translateMySql('SHOW CREATE TABLE')).toBeNull()
      expect(translateMySql('SHOW CREATE VIEW users')).toBeNull()
      expect(translateMySql('SHOW CREATE TABLE users users')).toBeNull()
    })
  })

  describe('SHOW INDEX / INDEXES / KEYS', () => {
    const expected = (table: string) =>
      [
        'SELECT',
        `  '${table}' AS "Table",`,
        '  CASE WHEN il."unique" THEN 0 ELSE 1 END AS "Non_unique",',
        "  CASE WHEN il.origin = 'pk' THEN 'PRIMARY' ELSE il.name END AS \"Key_name\",",
        '  (ii.seqno + 1) AS "Seq_in_index",',
        '  ii.name AS "Column_name",',
        '  \'A\' AS "Collation",',
        '  NULL AS "Cardinality",',
        '  NULL AS "Sub_part",',
        '  NULL AS "Packed",',
        '  CASE WHEN p."notnull" THEN \'\' ELSE \'YES\' END AS "Null",',
        '  \'BTREE\' AS "Index_type",',
        '  \'\' AS "Comment",',
        '  \'\' AS "Index_comment",',
        '  \'YES\' AS "Visible",',
        '  NULL AS "Expression"',
        `FROM pragma_index_list('${table}') AS il`,
        'JOIN pragma_index_info(il.name) AS ii',
        `LEFT JOIN pragma_table_info('${table}') AS p ON p.cid = ii.cid`,
        "ORDER BY CASE WHEN il.origin = 'pk' THEN 0 ELSE 1 END, il.name, ii.seqno",
      ].join('\n')

    it('rewrites SHOW INDEX, SHOW INDEXES and SHOW KEYS', () => {
      for (const form of [
        'SHOW INDEX FROM users',
        'SHOW INDEXES FROM users',
        'SHOW KEYS FROM users',
        'SHOW INDEX IN users',
      ]) {
        expect(sql(form)).toBe(expected('users'))
      }
    })

    it('supports backtick and double-quoted table names', () => {
      expect(sql('SHOW INDEX FROM `users`')).toBe(expected('users'))
      expect(sql('SHOW INDEX FROM "users"')).toBe(expected('users'))
    })

    it('falls through for unsupported forms', () => {
      expect(translateMySql('SHOW INDEX users')).toBeNull()
      expect(translateMySql('SHOW INDEX FROM')).toBeNull()
      expect(translateMySql('SHOW INDEX FROM users extra')).toBeNull()
    })
  })

  describe('SHOW DATABASES', () => {
    it('is reported as unsupported', () => {
      expect(translateMySql('SHOW DATABASES')).toEqual({
        type: 'error',
        message: expect.stringContaining('SHOW DATABASES'),
      })
      expect(translateMySql('SHOW DATABASES;')).toMatchObject({ type: 'error' })
      expect(translateMySql('show databases')).toMatchObject({ type: 'error' })
      expect(translateMySql('SHOW DATABASES extra')).toBeNull()
    })
  })

  describe('injection safety', () => {
    it('escapes single quotes in the table name', () => {
      expect(sql("DESCRIBE `x' OR 1=1`")).toContain("pragma_table_info('x'' OR 1=1')")
      expect(sql("SHOW CREATE TABLE `x'; DROP TABLE users; --`")).toContain("name = 'x''; DROP TABLE users; --'")
    })

    it('produces a single read-only statement that passes the guard', () => {
      for (const input of [
        'SHOW TABLES',
        "DESCRIBE `x' ; DROP TABLE t; --`",
        'SHOW CREATE TABLE users',
        'SHOW INDEX FROM users',
      ]) {
        const rewritten = sql(input)
        expect(classifySql(rewritten)).toBe('read')
        expect(classifySql(rewritten)).not.toBe('multiple')
      }
    })
  })

  describe('non-MySQL statements fall through', () => {
    it('returns null', () => {
      for (const input of [
        'SELECT * FROM users',
        'SHOW',
        'SHOWW TABLES',
        'DESCRIBE users; DROP TABLE users',
        'DROP TABLE users',
        'PRAGMA table_info(users)',
        '',
        '   ',
      ]) {
        expect(translateMySql(input)).toBeNull()
      }
    })
  })
})
