import type { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { fakeEnv } from '../../routes/__tests__/fakes'
import { sqliteD1 } from '../../routes/__tests__/sqlite-d1'
import type { Env } from '../../types'
import { tables } from '../db'
import { getMigrations } from '../migrations'
import { runMigrations } from '../migrations-runner'

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
  it('appends the registry and saved-run migrations to the collapsed schema_v1, with no PRAGMA probing', () => {
    const migrations = getMigrations(env('ZETA'))
    expect(migrations.map((m) => m.name)).toEqual(['schema_v1', 'schema_v2', 'schema_v3', 'schema_v4', 'schema_v5'])
    expect(migrations[0]!.sql).not.toMatch(/PRAGMA/)
    expect(migrations[0]!.sql).not.toMatch(/\bALTER TABLE\b/)
    // No SQL line comments: exec() collapses the SQL onto one line (see migrations-runner.ts)
    for (const migration of migrations) expect(migration.sql).not.toMatch(/--/)
  })

  it('adds the registry columns with a default that keeps every existing row a sqlite target', () => {
    const sql = getMigrations(env('ZETA')).find((m) => m.name === 'schema_v2')!.sql
    expect(sql).toContain("ALTER TABLE ZETA_d1_databases ADD COLUMN kind TEXT NOT NULL DEFAULT 'sqlite'")
    expect(sql).toContain('ALTER TABLE ZETA_d1_databases ADD COLUMN connection_secret TEXT')
    // Additive only: nothing is dropped, renamed or rewritten
    expect(sql).not.toMatch(/\b(DROP|RENAME)\b/i)
    expect(sql).not.toMatch(/UPDATE |DELETE /i)
  })

  it('adds the display-only provider column, nullable so every existing row keeps its current label', () => {
    const sql = getMigrations(env('ZETA')).find((m) => m.name === 'schema_v3')!.sql
    expect(sql).toBe('ALTER TABLE ZETA_d1_databases ADD COLUMN provider TEXT')
    // Additive only, and prefix-aware like every other statement
    expect(sql).not.toMatch(/\b(DROP|RENAME)\b/i)
    expect(sql).not.toMatch(/UPDATE |DELETE /i)
    expect(getMigrations(env('')).find((m) => m.name === 'schema_v3')!.sql).toBe(
      'ALTER TABLE d1_databases ADD COLUMN provider TEXT'
    )
  })

  it('adds the saved-run halted flag with a default that leaves every existing run unhalted', () => {
    const sql = getMigrations(env('ZETA')).find((m) => m.name === 'schema_v4')!.sql
    expect(sql).toBe('ALTER TABLE ZETA_notebook_runs ADD COLUMN halted INTEGER NOT NULL DEFAULT 0')
    // Additive only, and prefix-aware like every other statement
    expect(sql).not.toMatch(/\b(DROP|RENAME)\b/i)
    expect(sql).not.toMatch(/UPDATE |DELETE /i)
    expect(getMigrations(env('')).find((m) => m.name === 'schema_v4')!.sql).toBe(
      'ALTER TABLE notebook_runs ADD COLUMN halted INTEGER NOT NULL DEFAULT 0'
    )
  })

  it('creates the execution registry and the saved-run cancelled flag, both prefix-aware', () => {
    const sql = getMigrations(env('ZETA')).find((m) => m.name === 'schema_v5')!.sql
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS ZETA_executions (')
    expect(sql).toContain('CREATE INDEX IF NOT EXISTS idx_ZETA_executions_started ON ZETA_executions(started_at)')
    expect(sql).toContain('ALTER TABLE ZETA_notebook_runs ADD COLUMN cancelled INTEGER NOT NULL DEFAULT 0')
    expect(sql).toContain('REFERENCES ZETA_users(id)')
    expect(sql).toContain('REFERENCES ZETA_d1_databases(id)')
    // Additive only: nothing is dropped, renamed or rewritten (ON DELETE is the FK rule, not a query)
    expect(sql).not.toMatch(/\b(DROP|RENAME)\b/i)
    expect(sql).not.toMatch(/\bUPDATE\b|\bDELETE FROM\b/i)
    expect(getMigrations(env('')).find((m) => m.name === 'schema_v5')!.sql).toContain(
      'CREATE TABLE IF NOT EXISTS executions ('
    )
  })

  it('parameterises every table and index name by the effective prefix', () => {
    const sql = getMigrations(env('ZETA')).find((m) => m.name === 'schema_v1')!.sql
    const T = tables(env('ZETA'))
    // Every table schema_v1 creates (executions arrives in schema_v5)
    for (const name of Object.values(T).filter((name) => !name.endsWith('_executions'))) {
      expect(sql).toContain(name)
    }
    expect(sql).toContain('idx_ZETA_notebook_runs_seq')
    expect(sql).toContain('REFERENCES ZETA_users(id)')
    // ... and creates nothing unprefixed
    for (const name of Object.values(tables(env(''))).filter((name) => !name.endsWith('executions'))) {
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

    // The 11 tables of the collapsed baseline (schema_v5 adds executions later)
    expect(tableNames(sqlite)).toEqual(
      Object.values(tables(env('kp')))
        .filter((t) => !t.endsWith('_executions'))
        .sort()
    )
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

describe('schema_v2 applied after schema_v1', () => {
  it('backfills existing registrations as sqlite targets with no stored connection', () => {
    const { sqlite } = sqliteD1()
    for (const migration of getMigrations(env(''))) sqlite.exec(migration.sql)
    sqlite.exec(`
      INSERT INTO d1_databases (id, name, binding_name, cf_database_id, created_at)
      VALUES ('legacy', 'legacy', 'cf:uuid', 'uuid', 0);
      INSERT INTO d1_databases (id, name, binding_name, kind, connection_secret, created_at)
      VALUES ('pg', 'neon', 'pg:pg', 'postgres', 'enc:v1:sealed', 0);
    `)
    const rows = sqlite.prepare('SELECT id, kind, connection_secret FROM d1_databases ORDER BY id').all() as Array<{
      id: string
      kind: string
      connection_secret: string | null
    }>
    expect(rows).toEqual([
      { id: 'legacy', kind: 'sqlite', connection_secret: null },
      { id: 'pg', kind: 'postgres', connection_secret: 'enc:v1:sealed' },
    ])
  })
})

describe('schema_v3 applied after schema_v2', () => {
  it('upgrades a registry that already holds rows, and reads the new column back as null', async () => {
    const { db, sqlite } = sqliteD1()
    const env = fakeEnv({ DB: db, TABLE_PREFIX: '' })
    const migrations = getMigrations({ TABLE_PREFIX: '' })
    // The release that introduced v3: everything up to and including it
    const upToV3 = migrations.slice(0, migrations.findIndex((m) => m.name === 'schema_v3') + 1)
    expect(upToV3[upToV3.length - 1]!.name).toBe('schema_v3')

    // The state of a deployment that ran setup before this release: v1 + v2 recorded, rows present.
    const applied = await runMigrations(env, upToV3.slice(0, -1))
    expect(applied.migrations.map((m) => m.name)).toEqual(['schema_v1', 'schema_v2'])
    sqlite.exec(`
      INSERT INTO d1_databases (id, name, binding_name, kind, created_at)
      VALUES ('my', 'tidb', 'my:my', 'mysql', 0);
    `)

    // The admin panel's "check & upgrade" run: only the new entry is applied, and only then.
    const upgrade = await runMigrations(env, upToV3)
    expect(upgrade.migrations).toEqual([
      { name: 'schema_v1', status: 'skipped' },
      { name: 'schema_v2', status: 'skipped' },
      { name: 'schema_v3', status: 'applied' },
    ])
    expect(sqlite.prepare('SELECT id, kind, provider FROM d1_databases').all()).toEqual([
      { id: 'my', kind: 'mysql', provider: null },
    ])

    // The column takes a custom label and is cleared again by the edit path.
    sqlite.exec(`UPDATE d1_databases SET provider = 'Aiven' WHERE id = 'my'`)
    expect(sqlite.prepare('SELECT provider FROM d1_databases').all()).toEqual([{ provider: 'Aiven' }])
    sqlite.exec(`UPDATE d1_databases SET provider = NULL WHERE id = 'my'`)
    expect(sqlite.prepare('SELECT provider FROM d1_databases').all()).toEqual([{ provider: null }])
  })
})

describe('schema_v4 applied after schema_v3', () => {
  it('adds the halted flag to a runs table that already holds runs, rewriting none of them', async () => {
    const { db, sqlite } = sqliteD1()
    const env = fakeEnv({ DB: db, TABLE_PREFIX: '' })
    const migrations = getMigrations({ TABLE_PREFIX: '' })
    const upToV4 = migrations.slice(0, migrations.findIndex((m) => m.name === 'schema_v4') + 1)
    expect(upToV4[upToV4.length - 1]!.name).toBe('schema_v4')

    // A deployment whose saved runs predate the flag
    await runMigrations(env, upToV4.slice(0, -1))
    sqlite.exec(`
      INSERT INTO users (id, email, name, role, created_at, updated_at)
      VALUES ('u1', 'u@example.com', 'U', 'member', 0, 0);
      INSERT INTO d1_databases (id, name, binding_name, kind, created_at)
      VALUES ('db1', 'one', 'cf:db1', 'sqlite', 0);
      INSERT INTO notebooks (id, user_id, name, created_at, updated_at) VALUES ('nb1', 'u1', 'One', 0, 0);
      INSERT INTO notebook_runs (id, notebook_id, user_id, database_id, sql, statement_count, row_count,
        error_count, duration_ms, storage_truncated, results_bytes, executed_at, seq, results)
      VALUES ('r1', 'nb1', 'u1', 'db1', 'SELECT 1', 1, 1, 0, 1, 0, 10, 0, 1, '[]');
    `)

    const upgrade = await runMigrations(env, upToV4)
    expect(upgrade.migrations).toEqual([
      { name: 'schema_v1', status: 'skipped' },
      { name: 'schema_v2', status: 'skipped' },
      { name: 'schema_v3', status: 'skipped' },
      { name: 'schema_v4', status: 'applied' },
    ])
    // The run that existed before the upgrade reads as "ran to the end": nothing was backfilled
    expect(sqlite.prepare('SELECT id, halted FROM notebook_runs').all()).toEqual([{ id: 'r1', halted: 0 }])
  })
})
