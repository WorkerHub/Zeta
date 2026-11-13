import { describe, it, expect } from 'vitest'
import { classifySql, checkSqlAccess, limitReadSql, type SqlClass } from '../sql-guard'

const ctes = (n: number) => Array.from({ length: n }, (_, i) => `c${i} AS (SELECT ${i})`).join(', ')

describe('classifySql', () => {
  const cases: Array<[string, string, SqlClass]> = [
    ['select', 'SELECT * FROM t', 'read'],
    ['select with trailing semicolon', 'SELECT 1;', 'read'],
    ['leading comments', '-- hi\n/* x */ SELECT 1', 'read'],
    ['values', 'VALUES (1), (2)', 'read'],
    ['explain', 'EXPLAIN QUERY PLAN SELECT 1', 'read'],
    ['explain analyze read', 'EXPLAIN ANALYZE SELECT 1', 'read'],
    ['explain analyze write', 'EXPLAIN ANALYZE DELETE FROM t', 'write'],
    ['explain analyze options write', 'EXPLAIN (ANALYZE, BUFFERS) DELETE FROM t', 'write'],
    ['explain options only', 'EXPLAIN (VERBOSE, COSTS OFF) SELECT 1', 'read'],
    ['keyword inside string', "SELECT 'DELETE FROM t; DROP TABLE t'", 'read'],
    ['keyword inside comment', 'SELECT 1 -- ; DELETE FROM t', 'read'],
    ['read-only pragma', 'PRAGMA table_info(users)', 'read'],
    ['schema-qualified read pragma', 'PRAGMA main.table_info(users)', 'read'],
    ['cte select', 'WITH a AS (SELECT 1) SELECT * FROM a', 'read'],
    [
      'recursive cte',
      'WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM r WHERE n<5) SELECT n FROM r',
      'read',
    ],
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
    ['data-modifying cte', 'WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d', 'write'],
    ['data-modifying cte + insert', 'WITH i AS (INSERT INTO t VALUES (1) RETURNING *) SELECT * FROM i', 'write'],
    ['data-modifying cte + update', 'WITH u AS (UPDATE t SET a = 1 RETURNING *) SELECT * FROM u', 'write'],
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
    ['copy from file', "COPY t FROM '/tmp/x'", 'forbidden'],
    ['copy to stdout', 'COPY t TO STDOUT', 'forbidden'],
    ['load data', "LOAD DATA INFILE '/x' INTO TABLE t", 'forbidden'],

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

describe('classifySql (postgres dialect)', () => {
  const cases: Array<[string, string, SqlClass]> = [
    ['plain select', 'SELECT 1', 'read'],
    ['cast', "SELECT '1'::int + 1", 'read'],
    ['dollar-quoted string with a semicolon', 'SELECT $$a;b$$', 'read'],
    ['tagged dollar quote', 'SELECT $fn$DELETE FROM t; SELECT 1$fn$', 'read'],
    [
      'function body is one statement',
      'CREATE FUNCTION f() RETURNS int AS $$ BEGIN RETURN 1; END $$ LANGUAGE plpgsql',
      'write',
    ],
    ['dollar quote cannot fake a second statement', 'SELECT $$x$$; DELETE FROM t', 'multiple'],
    ['escape string with an embedded quote', "SELECT E'it\\'s' FROM t", 'read'],
    ['data-modifying cte', 'WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d', 'write'],
    ['read cte with replace()', "WITH a AS (SELECT replace('a','b','c') x) SELECT x FROM a", 'read'],
    ['materialized cte', 'WITH a AS MATERIALIZED (SELECT 1) SELECT * FROM a', 'read'],
    ['not materialized cte', 'WITH a AS NOT MATERIALIZED (SELECT 1) SELECT * FROM a', 'read'],
    ['materialized data-modifying cte', 'WITH d AS MATERIALIZED (DELETE FROM t RETURNING *) SELECT * FROM d', 'write'],
    ['explain select', 'EXPLAIN SELECT 1', 'read'],
    ['explain analyze select', 'EXPLAIN ANALYZE SELECT 1', 'read'],
    ['explain analyze delete', 'EXPLAIN ANALYZE DELETE FROM t', 'write'],
    ['explain analyze options delete', 'EXPLAIN (ANALYZE, BUFFERS) DELETE FROM t', 'write'],
    ['explain analyze without a statement', 'EXPLAIN ANALYZE', 'write'],
    ['copy', "COPY t FROM '/tmp/x'", 'forbidden'],
    ['copy query', 'COPY (SELECT 1) TO STDOUT', 'forbidden'],
    ['load data', "LOAD DATA INFILE '/x' INTO TABLE t", 'forbidden'],
    ['select into creates a table', 'SELECT * INTO t2 FROM t', 'write'],
    ['select into inside a subquery is still a read', 'SELECT * FROM (SELECT 1) x', 'read'],
    ['show', 'SHOW server_version', 'read'],
    ['locking read', 'SELECT * FROM t FOR UPDATE', 'read'],
    ['destructive', 'DROP TABLE t', 'destructive'],
  ]

  for (const [name, sql, expected] of cases) {
    it(`${name} -> ${expected}`, () => {
      expect(classifySql(sql, 'postgres')).toBe(expected)
    })
  }
})

describe('classifySql (mysql dialect)', () => {
  const cases: Array<[string, string, SqlClass]> = [
    // reads — the introspection statements a TiDB Cloud Starter target actually gets
    ['plain select', 'SELECT 1', 'read'],
    ['select with a backtick identifier', 'SELECT `a;b` FROM `t`', 'read'],
    ['show tables', 'SHOW TABLES', 'read'],
    ['show create table', 'SHOW CREATE TABLE t', 'read'],
    ['show columns', 'SHOW COLUMNS FROM t', 'read'],
    ['show index', 'SHOW INDEX FROM t', 'read'],
    ['show variables', "SHOW VARIABLES LIKE 'max%'", 'read'],
    ['describe', 'DESCRIBE t', 'read'],
    ['desc', 'DESC t', 'read'],
    ['explain', 'EXPLAIN SELECT * FROM t', 'read'],
    ['explain format', 'EXPLAIN FORMAT=JSON SELECT * FROM t', 'read'],
    ['explain analyze select', 'EXPLAIN ANALYZE SELECT * FROM t', 'read'],
    ['explain analyze delete', 'EXPLAIN ANALYZE DELETE FROM t', 'write'],
    ['cte select', 'WITH a AS (SELECT 1) SELECT * FROM a', 'read'],

    // writes
    ['insert', 'INSERT INTO t VALUES (1)', 'write'],
    ['replace', 'REPLACE INTO t VALUES (1)', 'write'],
    ['update', 'UPDATE t SET a = 1', 'write'],
    ['delete', 'DELETE FROM t', 'write'],
    ['create table', 'CREATE TABLE t (a INT)', 'write'],
    ['alter add', 'ALTER TABLE t ADD COLUMN b INT', 'write'],
    ['analyze table', 'ANALYZE TABLE t', 'write'],
    ['optimize table', 'OPTIMIZE TABLE t', 'write'],
    ['repair table', 'REPAIR TABLE t', 'write'],
    ['rename table', 'RENAME TABLE a TO b', 'write'],
    ['call', 'CALL p(1)', 'write'],
    ['data-modifying cte', 'WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d', 'write'],

    // destructive
    ['drop', 'DROP TABLE t', 'destructive'],
    ['truncate', 'TRUNCATE t', 'destructive'],
    ['alter drop column', 'ALTER TABLE t DROP COLUMN b', 'destructive'],

    // forbidden
    ['load data infile', "LOAD DATA INFILE '/x' INTO TABLE t", 'forbidden'],
    ['load data local infile', "LOAD DATA LOCAL INFILE '/x' INTO TABLE t", 'forbidden'],
    ['select into outfile', "SELECT * FROM t INTO OUTFILE '/tmp/x'", 'forbidden'],
    ['select into dumpfile', "SELECT * FROM t INTO DUMPFILE '/tmp/x'", 'forbidden'],
    ['lock tables', 'LOCK TABLES t WRITE', 'forbidden'],
    ['unlock tables', 'UNLOCK TABLES', 'forbidden'],
    ['prepare', "PREPARE s FROM 'SELECT 1'", 'forbidden'],
    ['execute', 'EXECUTE s', 'forbidden'],
    ['deallocate', 'DEALLOCATE PREPARE s', 'forbidden'],
    ['grant', 'GRANT ALL ON *.* TO u', 'forbidden'],
    ['revoke', 'REVOKE ALL ON *.* FROM u', 'forbidden'],
    ['create user', "CREATE USER u IDENTIFIED BY 'x'", 'forbidden'],
    ['create role', 'CREATE ROLE r', 'forbidden'],
    ['flush', 'FLUSH PRIVILEGES', 'forbidden'],
    ['kill', 'KILL 1', 'forbidden'],
    ['shutdown', 'SHUTDOWN', 'forbidden'],
    ['start transaction', 'START TRANSACTION', 'forbidden'],
    // `BEGIN` is MySQL's synonym of START TRANSACTION: the live re-check showed the endpoint keeps one
    // session per credentials, so an open transaction there would capture every other request.
    ['begin', 'BEGIN', 'forbidden'],
    ['commit', 'COMMIT', 'forbidden'],
    ['rollback', 'ROLLBACK', 'forbidden'],
    ['savepoint', 'SAVEPOINT s', 'forbidden'],
    ['use', 'USE other', 'forbidden'],
    ['set', 'SET @x = 1', 'forbidden'],
    ['show processlist', 'SHOW PROCESSLIST', 'forbidden'],
    ['show full processlist', 'SHOW FULL PROCESSLIST', 'forbidden'],
    ['show grants', 'SHOW GRANTS', 'forbidden'],
    ['handler', 'HANDLER t OPEN', 'forbidden'],

    // scanner patches
    ['executable comment', '/*!50000 DELETE FROM t */', 'forbidden'],
    ['executable comment inside a read', 'SELECT 1 /*! , 2 */', 'forbidden'],
    ['optimizer hint is a plain comment', '/*+ MAX_EXECUTION_TIME(1000) */ SELECT 1', 'read'],
    ['hash comment hides nothing', 'SELECT 1 # ; DROP TABLE t', 'read'],
    ['escaped quote keeps the statement in its string', "SELECT 'it\\'s; DROP TABLE x' FROM t", 'read'],
    ['escaped double quote', 'SELECT "a\\"b; c" FROM t', 'read'],
    ['multi-statement is still refused', 'SELECT 1; SELECT 2', 'multiple'],
    // `[` is not a MySQL quote: it cannot be used to hide a second statement
    ['bracket does not hide a second statement', 'SELECT 1 [; DROP TABLE t', 'multiple'],
  ]

  for (const [name, sql, expected] of cases) {
    it(`${name} -> ${expected}`, () => {
      expect(classifySql(sql, 'mysql')).toBe(expected)
    })
  }
})

describe('limitReadSql (mysql dialect)', () => {
  it('wraps reads in an aliased derived table', () => {
    expect(limitReadSql('SELECT * FROM t', 5000, 'mysql')).toBe(
      'SELECT * FROM (\nSELECT * FROM t\n) AS zeta_limit LIMIT 5001'
    )
    expect(limitReadSql('WITH a AS (SELECT 1) SELECT * FROM a', 10, 'mysql')).toBe(
      'SELECT * FROM (\nWITH a AS (SELECT 1) SELECT * FROM a\n) AS zeta_limit LIMIT 11'
    )
    // A hash comment cannot swallow the closing parenthesis: it ends at the newline
    expect(limitReadSql('SELECT 1 # note', 10, 'mysql')).toBe(
      'SELECT * FROM (\nSELECT 1 # note\n) AS zeta_limit LIMIT 11'
    )
  })

  it('leaves row-locking reads and introspection to the caller row cap', () => {
    for (const sql of [
      'SELECT * FROM t FOR UPDATE',
      'SELECT * FROM t FOR SHARE',
      'SELECT * FROM t LOCK IN SHARE MODE',
      'SHOW TABLES',
      'DESCRIBE t',
      'EXPLAIN ANALYZE SELECT 1',
    ]) {
      expect(limitReadSql(sql, 10, 'mysql'), sql).toBeNull()
    }
  })
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

describe('limitReadSql', () => {
  it('wraps SELECT, VALUES and read-only WITH in a LIMIT one past the cap', () => {
    for (const sql of [
      'SELECT * FROM t',
      'VALUES (1), (2)',
      'WITH a AS (SELECT 1) SELECT * FROM a',
      'SELECT * FROM t ORDER BY x DESC LIMIT 10 OFFSET 5',
    ]) {
      const wrapped = limitReadSql(sql, 5000)
      expect(wrapped).toBe(`SELECT * FROM (\n${sql}\n) LIMIT 5001`)
      expect(classifySql(wrapped!)).toBe('read')
    }
  })

  it('drops the trailing semicolon and keeps comments from swallowing the parenthesis', () => {
    expect(limitReadSql('SELECT 1;', 10)).toBe('SELECT * FROM (\nSELECT 1\n) LIMIT 11')
    expect(limitReadSql("SELECT ';' FROM t; -- done", 10)).toBe("SELECT * FROM (\nSELECT ';' FROM t\n) LIMIT 11")
    expect(limitReadSql('SELECT 1 -- note', 10)).toBe('SELECT * FROM (\nSELECT 1 -- note\n) LIMIT 11')
    expect(limitReadSql('SELECT 1 /* open', 10)).toBe('SELECT * FROM (\nSELECT 1 /* open*/\n) LIMIT 11')
  })

  it('leaves EXPLAIN and PRAGMA unwrapped', () => {
    expect(limitReadSql('EXPLAIN QUERY PLAN SELECT 1', 10)).toBeNull()
    expect(limitReadSql('PRAGMA table_info(users)', 10)).toBeNull()
  })

  it('wraps PostgreSQL reads with a subquery alias and never with the SQLite shape', () => {
    expect(limitReadSql('SELECT * FROM t', 5000, 'postgres')).toBe(
      'SELECT * FROM (\nSELECT * FROM t\n) AS zeta_limit LIMIT 5001'
    )
    expect(limitReadSql('WITH a AS (SELECT 1) SELECT * FROM a', 10, 'postgres')).toBe(
      'SELECT * FROM (\nWITH a AS (SELECT 1) SELECT * FROM a\n) AS zeta_limit LIMIT 11'
    )
    // A dollar-quoted body may contain a parenthesis or a semicolon without breaking the wrap
    expect(limitReadSql('SELECT $$a)b$$', 10, 'postgres')).toBe(
      'SELECT * FROM (\nSELECT $$a)b$$\n) AS zeta_limit LIMIT 11'
    )
  })

  it("leaves PostgreSQL reads that cannot be wrapped to the caller's row cap", () => {
    for (const sql of [
      'SELECT * FROM t FOR UPDATE',
      'SELECT * FROM t FOR SHARE',
      'SELECT * FROM t FOR NO KEY UPDATE',
      'SHOW server_version',
      'EXPLAIN ANALYZE SELECT 1',
    ]) {
      expect(limitReadSql(sql, 10, 'postgres'), sql).toBeNull()
    }
  })

  it('cannot be used to smuggle in a second statement', () => {
    // A top-level `;` is rejected before any rewriting
    expect(classifySql('SELECT 1) ; DELETE FROM t; SELECT (1')).toBe('multiple')
  })

  it('does not wrap SQL with unbalanced parentheses, which could escape the outer LIMIT', () => {
    expect(limitReadSql('SELECT 1) UNION SELECT (2', 10)).toBeNull()
    expect(limitReadSql('SELECT 1), t WHERE x IN (SELECT 1', 10)).toBeNull()
    expect(limitReadSql('SELECT (1', 10)).toBeNull()
    // Parentheses inside strings, identifiers and comments do not count
    expect(limitReadSql('SELECT \')\' AS "(" -- (', 10)).not.toBeNull()
  })
})
