import { describe, expect, it } from 'vitest'
import type { Env } from '../../types'
import { appDbWriteTargetError, appInternalTables, capAppDbPermission } from '../app-db-guard'
import { migrationsTable } from '../db'
import { checkSqlAccess, classifySql, isWriteClass, type Permission } from '../sql-guard'

const env = (overrides: Partial<Env> = {}) =>
  ({ TABLE_PREFIX: undefined, ...overrides }) as unknown as Pick<Env, 'TABLE_PREFIX'>

// The three TABLE_PREFIX resolution states, as internal-table sets:
//   unset → DEFAULT_TABLE_PREFIX ('zeta_'),  non-empty → `${value}_`,  '' → unprefixed
const T = appInternalTables(env()) // unset: the zeta_-prefixed default
const U = appInternalTables(env({ TABLE_PREFIX: '' })) // '': unprefixed
const TP = appInternalTables(env({ TABLE_PREFIX: 'kp' })) // 'kp': kp_-prefixed

describe('appInternalTables', () => {
  it('is every table tables(env) resolves to, zeta_-prefixed by default', () => {
    expect([...T].sort()).toEqual(
      [
        'zeta_users',
        'zeta_totp_credentials',
        'zeta_passkey_credentials',
        'zeta_d1_databases',
        'zeta_user_database_permissions',
        'zeta_query_history',
        'zeta_settings',
        'zeta_audit_logs',
        'zeta_notebooks',
        'zeta_notebook_runs',
        'zeta_rate_limits',
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
  const internal = (sql: string, set: ReadonlySet<string> = U) => {
    const err = appDbWriteTargetError(sql, set)
    expect(err).toBeTypeOf('string')
    expect(err).toMatch(/application internal table/i)
  }
  // Writes to tables outside the set pass
  const allowed = (sql: string, set: ReadonlySet<string> = U) => {
    expect(appDbWriteTargetError(sql, set)).toBeNull()
  }
  // Statements whose target table cannot be pinned down are rejected fail-closed
  const unresolvable = (sql: string, set: ReadonlySet<string> = U) => {
    const err = appDbWriteTargetError(sql, set)
    expect(err).toBeTypeOf('string')
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

// ── ONE-352 checkpoint: the schema-migration ledger on the application database ───────────────
// `appInternalTables()` is derived from tables(env), so the ledger is NOT in the read-only set.
// This measures what that means end to end through the query route's actual decision path:
// classifySql → capped permission (app DB) → checkSqlAccess → appDbWriteTargetError.
describe('migration ledger as a query target on the application database', () => {
  const APP = env({ TABLE_PREFIX: 'ZETA' })
  const LEDGER = migrationsTable(APP) // _ZETA_schema_migrations
  // The effective guard outcome for a statement on the app DB; null means "runs".
  const outcome = (sql: string, permission: Permission = 'write_drop') => {
    const kind = classifySql(sql)
    const denied = checkSqlAccess(kind, capAppDbPermission(permission))
    if (denied !== null) return denied
    return isWriteClass(kind) ? appDbWriteTargetError(sql, appInternalTables(APP)) : null
  }

  it('is not part of the internal-table set', () => {
    expect(LEDGER).toBe('_ZETA_schema_migrations')
    expect(appInternalTables(APP).has(LEDGER.toLowerCase())).toBe(false)
  })

  it('is visible to read queries', () => {
    expect(outcome(`SELECT * FROM ${LEDGER}`)).toBeNull()
  })

  it('is writable: INSERT / UPDATE / DELETE are only subject to the ordinary permission check', () => {
    expect(outcome(`INSERT INTO ${LEDGER} (name) VALUES ('schema_v1')`)).toBeNull()
    expect(outcome(`UPDATE ${LEDGER} SET name = 'x' WHERE name = 'schema_v1'`)).toBeNull()
    expect(outcome(`DELETE FROM ${LEDGER}`)).toBeNull()
    // ... and a read-only grant still blocks them
    expect(outcome(`DELETE FROM ${LEDGER}`, 'read')).toMatch(/only have read access/i)
  })

  it('can be reshaped but not destroyed: ALTER … ADD COLUMN passes, DROP is capped', () => {
    // ALTER … ADD COLUMN classifies as `write`, and the internal-table rule does not cover the
    // ledger, so it runs; the destructive forms are stopped by the app-DB permission cap.
    expect(outcome(`ALTER TABLE ${LEDGER} ADD COLUMN forged TEXT`)).toBeNull()
    expect(outcome(`DROP TABLE ${LEDGER}`)).toMatch(/elevated permissions/i)
    expect(outcome(`ALTER TABLE ${LEDGER} DROP COLUMN name`)).toMatch(/elevated permissions/i)
    // A trigger body is unresolvable and therefore rejected fail-closed
    expect(outcome(`CREATE TRIGGER t AFTER INSERT ON t1 BEGIN DELETE FROM ${LEDGER}; END`)).not.toBeNull()
  })
})
