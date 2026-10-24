import { describe, expect, it } from 'vitest'
import type { Env } from '../../types'
import { appDbWriteTargetError, appInternalTables, capAppDbPermission } from '../app-db-guard'

const env = (overrides: Partial<Env> = {}) =>
  ({ TABLE_PREFIX: undefined, ...overrides }) as unknown as Pick<Env, 'TABLE_PREFIX'>

// The default (unprefixed) internal table set
const T = appInternalTables(env())
// A prefixed set, as a TABLE_PREFIX deployment resolves it
const TP = appInternalTables(env({ TABLE_PREFIX: 'kp' }))

describe('appInternalTables', () => {
  it('is every table tables(env) resolves to, unprefixed by default', () => {
    expect([...T].sort()).toEqual(
      [
        'users',
        'totp_credentials',
        'passkey_credentials',
        'd1_databases',
        'user_database_permissions',
        'query_history',
        'settings',
        'audit_logs',
        'notebooks',
        'notebook_runs',
        'rate_limits',
      ].sort()
    )
  })

  it('follows TABLE_PREFIX — no hardcoded names', () => {
    expect(TP.has('kp_users')).toBe(true)
    expect(TP.has('users')).toBe(false)
    expect(TP.size).toBe(T.size)
  })
})

describe('capAppDbPermission', () => {
  it('caps write_drop at write and leaves read/write alone', () => {
    expect(capAppDbPermission('write_drop')).toBe('write')
    expect(capAppDbPermission('write')).toBe('write')
    expect(capAppDbPermission('read')).toBe('read')
  })
})

describe('appDbWriteTargetError', () => {
  // Internal-table writes are rejected, with a message naming the protection
  const internal = (sql: string, set: ReadonlySet<string> = T) => {
    const err = appDbWriteTargetError(sql, set)
    expect(err).toMatch(/application internal table/i)
  }
  // Writes to tables outside the set pass
  const allowed = (sql: string, set: ReadonlySet<string> = T) => {
    expect(appDbWriteTargetError(sql, set)).toBeNull()
  }
  // Statements whose target table cannot be pinned down are rejected fail-closed
  const unresolvable = (sql: string, set: ReadonlySet<string> = T) => {
    const err = appDbWriteTargetError(sql, set)
    expect(err).toMatch(/cannot be determined/i)
  }

  it('rejects writes against internal tables across statement forms', () => {
    internal('INSERT INTO users (email) VALUES (1)')
    internal('INSERT OR IGNORE INTO users VALUES (1)')
    internal('REPLACE INTO users VALUES (1)')
    internal('UPDATE users SET name = 1')
    internal('UPDATE OR ROLLBACK users SET name = 1')
    internal('DELETE FROM users')
    internal('CREATE TABLE users (a)')
    internal('CREATE TABLE IF NOT EXISTS users (a)')
    internal('CREATE TEMP TABLE users (a)')
    internal('CREATE UNIQUE INDEX i ON users (email)')
    internal('CREATE INDEX IF NOT EXISTS i ON users (email)')
    internal('ALTER TABLE users ADD COLUMN b')
    internal('ALTER TABLE users RENAME TO users2')
    internal('WITH a AS (SELECT 1) DELETE FROM users')
    internal('WITH a AS (SELECT 1) INSERT INTO users SELECT * FROM a')
    internal('WITH RECURSIVE r(n) AS (SELECT 1) UPDATE users SET a = 1')
  })

  it('allows writes against non-internal tables in the same forms', () => {
    allowed('INSERT INTO logs (a) VALUES (1)')
    allowed('REPLACE INTO logs VALUES (1)')
    allowed('UPDATE logs SET a = 1')
    allowed('UPDATE OR IGNORE logs SET a = 1')
    allowed('DELETE FROM logs')
    allowed('CREATE TABLE logs (a)')
    allowed('CREATE TABLE IF NOT EXISTS logs (a)')
    allowed('CREATE INDEX i ON logs (a)')
    allowed('ALTER TABLE logs ADD COLUMN b')
    allowed('WITH a AS (SELECT 1) DELETE FROM logs')
    // A statement whose target table only collides by prefix is fine
    allowed('INSERT INTO users_archive (a) VALUES (1)')
  })

  it('matches case-insensitively and follows TABLE_PREFIX', () => {
    internal('INSERT INTO USERS VALUES (1)')
    internal('delete from Notebook_Runs')
    // The prefixed set protects the prefixed names only
    internal('INSERT INTO kp_users VALUES (1)', TP)
    allowed('INSERT INTO users VALUES (1)', TP)
    allowed('INSERT INTO kp_other VALUES (1)', TP)
  })

  it('resolves schema-qualified target tables', () => {
    internal('INSERT INTO main.users VALUES (1)')
    internal('DELETE FROM main.users')
    allowed('INSERT INTO main.logs VALUES (1)')
  })

  it('rejects writes whose target table cannot be determined, fail closed', () => {
    // Quoted identifiers are opaque to the tokenizer
    unresolvable('INSERT INTO "users" VALUES (1)')
    unresolvable('INSERT INTO `users` VALUES (1)')
    unresolvable('DELETE FROM [users]')
    unresolvable('INSERT INTO main."users" VALUES (1)')
    // Statement forms with no target table
    unresolvable('VACUUM')
    unresolvable('REINDEX')
    unresolvable('ANALYZE')
    unresolvable('BEGIN')
    unresolvable('CREATE VIEW v AS SELECT 1')
    // CREATE TRIGGER fails closed like CREATE VIEW: its body can write any table when the
    // trigger fires, so the attached table is not the statement's only target — a trigger
    // created on a non-internal table must not be able to mutate internal tables later.
    unresolvable('CREATE TRIGGER bypass AFTER INSERT ON logs BEGIN DELETE FROM users END')
    unresolvable('CREATE TRIGGER bypass AFTER INSERT ON logs BEGIN DELETE FROM users; END')
    unresolvable('CREATE TEMP TRIGGER IF NOT EXISTS bypass AFTER INSERT ON logs BEGIN UPDATE users SET name = 1 END')
    // WITH that ends after its CTE list, or an unparseable CTE prefix
    unresolvable('WITH a AS (SELECT 1)')
    unresolvable('WITH a (SELECT 1) DELETE FROM logs')
    // Malformed heads
    unresolvable('INSERT logs VALUES (1)') // INTO missing
    unresolvable('CREATE TABLE')
    unresolvable('CREATE INDEX')
    // Unknown leading token / garbage (classification rates these write)
    unresolvable('(SELECT 1)')
    unresolvable('@@@')
  })

  it('ignores trailing statement terminators and comments before the head', () => {
    allowed('INSERT INTO logs VALUES (1);')
    allowed('INSERT INTO logs VALUES (1);;')
    internal('INSERT INTO users VALUES (1);')
    internal('INSERT INTO users VALUES (1);;')
    internal('-- note\n/* x */ DELETE FROM users')
    internal("INSERT INTO users VALUES ('DELETE FROM logs; DROP TABLE logs')")
  })
})
