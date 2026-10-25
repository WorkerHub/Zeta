import type { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { sqliteD1 } from '../../routes/__tests__/sqlite-d1'
import type { Env } from '../../types'
import { tables } from '../db'
import { getMigrations } from '../migrations'

// schema_v1 is the single schema definition (lib/migrations.ts). These tests apply it to a real
// SQLite database so they check actual SQL, not string patterns.

const env = (TABLE_PREFIX?: string) => ({ TABLE_PREFIX }) as Pick<Env, 'TABLE_PREFIX'>

const tableNames = (sqlite: DatabaseSync) =>
  (sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>)
    .map((r) => r.name)
    .sort()

const indexNames = (sqlite: DatabaseSync) =>
  (
    sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL").all() as Array<{
      name: string
    }>
  ).map((r) => r.name)

// Every statement in schema_v1, in order — the migration's SQL is generated from them.
const statements = (prefix: string | undefined) =>
  (getMigrations(env(prefix)).find((m) => m.name === 'schema_v1')!.sql as string).split(';\n')

describe('getMigrations', () => {
  it('is the single source of truth: one collapsed schema_v1, no PRAGMA probing', () => {
    const migrations = getMigrations(env('ZETA'))
    expect(migrations.map((m) => m.name)).toEqual(['schema_v1'])
    expect(migrations[0]!.sql).not.toMatch(/PRAGMA/)
    expect(migrations[0]!.sql).not.toMatch(/\bALTER TABLE\b/)
    // No SQL line comments: exec() collapses the SQL onto one line (see migrations-runner.ts)
    expect(migrations[0]!.sql).not.toMatch(/--/)
  })

  it('parameterises every table and index name by the effective prefix', () => {
    const sql = getMigrations(env('ZETA')).find((m) => m.name === 'schema_v1')!.sql
    const T = tables(env('ZETA'))
    for (const name of Object.values(T)) expect(sql).toContain(name)
    expect(sql).toContain('idx_ZETA_notebook_runs_seq')
    expect(sql).toContain('REFERENCES ZETA_users(id)')
    // ... and creates nothing unprefixed
    for (const name of Object.values(tables(env('')))) {
      expect(sql).not.toMatch(new RegExp(`CREATE TABLE IF NOT EXISTS ${name}\\b`))
    }
  })

  it('is prefix-aware for an unprefixed deployment and the default prefix', () => {
    expect(statements('').some((s) => s.includes('CREATE TABLE IF NOT EXISTS users ('))).toBe(true)
    expect(statements('').some((s) => s.includes('REFERENCES users(id)'))).toBe(true)
    expect(statements(undefined).some((s) => s.includes('CREATE TABLE IF NOT EXISTS zeta_users ('))).toBe(true)
  })
})

describe('schema_v1 applied to a real database', () => {
  it('creates the 11 tables and their indexes', () => {
    const { sqlite } = sqliteD1()
    sqlite.exec(getMigrations(env('kp')).find((m) => m.name === 'schema_v1')!.sql)

    expect(tableNames(sqlite)).toEqual(Object.values(tables(env('kp'))).sort())
    expect(indexNames(sqlite).sort()).toEqual(
      [
        'idx_kp_users_email',
        'idx_kp_totp_credentials_user',
        'idx_kp_passkey_credentials_user',
        'idx_kp_user_database_permissions_user',
        'idx_kp_user_database_permissions_db',
        'idx_kp_query_history_user',
        'idx_kp_query_history_db',
        'idx_kp_query_history_executed',
        'idx_kp_audit_logs_user',
        'idx_kp_audit_logs_created',
        'idx_kp_notebooks_user',
        'idx_kp_notebook_runs_user',
        'idx_kp_notebook_runs_seq',
        'idx_kp_rate_limits_expires',
      ].sort()
    )
  })

  it('points the permissions and history foreign keys at the prefixed tables, with the final cascade rules', () => {
    const { sqlite } = sqliteD1()
    sqlite.exec(getMigrations(env('ZETA')).find((m) => m.name === 'schema_v1')!.sql)

    const fks = (table: string) =>
      (
        sqlite.prepare(`PRAGMA foreign_key_list(${table})`).all() as Array<{
          from: string
          table: string
          on_delete: string
        }>
      )
        .map((fk) => `${fk.from}->${fk.table} ${fk.on_delete}`)
        .sort()

    expect(fks('ZETA_user_database_permissions')).toEqual([
      'database_id->ZETA_d1_databases CASCADE',
      'granted_by->ZETA_users NO ACTION',
      'user_id->ZETA_users CASCADE',
    ])
    expect(fks('ZETA_query_history')).toEqual([
      'database_id->ZETA_d1_databases SET NULL',
      'user_id->ZETA_users SET NULL',
    ])
  })

  it('does not seed settings (runSetup seeds them as a setup step)', () => {
    const { sqlite } = sqliteD1()
    sqlite.exec(getMigrations(env('')).find((m) => m.name === 'schema_v1')!.sql)
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM settings').all()).toEqual([{ n: 0 }])
  })
})
