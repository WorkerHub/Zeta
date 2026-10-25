import type { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { fakeEnv } from '../../routes/__tests__/fakes'
import { sqliteD1 } from '../../routes/__tests__/sqlite-d1'
import type { Env } from '../../types'
import { migrationsTable, tables } from '../db'
import type { Migration } from '../migrations'
import { runMigrations, TablePrefixConflictError } from '../migrations-runner'

// Real SQLite: the runner's semantics (record after success, stop at the first failure) are only
// meaningful against a database that actually applies the DDL.

type Envish = Pick<Env, 'DB' | 'TABLE_PREFIX'>

const ledgerRows = (sqlite: DatabaseSync, table = '_schema_migrations') =>
  (sqlite.prepare(`SELECT name FROM ${table} ORDER BY name`).all() as Array<{ name: string }>).map((r) => r.name)

const schemaSnapshot = (sqlite: DatabaseSync) =>
  sqlite.prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all()

const tableNames = (sqlite: DatabaseSync) =>
  (sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(
    (r) => r.name
  )

// Two tiny test migrations: the runner itself is independent of the production schema.
const TEST_MIGRATIONS: Migration[] = [
  {
    name: 'schema_v1',
    sql: 'CREATE TABLE IF NOT EXISTS one (id TEXT);\nCREATE INDEX IF NOT EXISTS idx_one_id ON one(id)',
  },
  { name: 'schema_v2', sql: 'CREATE TABLE IF NOT EXISTS two (id TEXT)' },
]

describe('runMigrations', () => {
  it('applies every migration on an empty database and records each one', async () => {
    const { db, sqlite } = sqliteD1()
    const env: Envish = fakeEnv({ DB: db, TABLE_PREFIX: '' })

    const result = await runMigrations(env)

    expect(result).toEqual({
      prefix: '',
      migrations: [{ name: 'schema_v1', status: 'applied' }],
    })
    // The ledger contains exactly schema_v1, and the schema really landed
    expect(ledgerRows(sqlite)).toEqual(['schema_v1'])
    expect(tableNames(sqlite)).toEqual(expect.arrayContaining([...Object.values(tables(env)), '_schema_migrations']))
  })

  it('skips everything on a second run and leaves the schema untouched', async () => {
    const { db, sqlite } = sqliteD1()
    const env: Envish = fakeEnv({ DB: db, TABLE_PREFIX: '' })
    await runMigrations(env)
    const before = schemaSnapshot(sqlite)

    const second = await runMigrations(env)

    expect(second).toEqual({ prefix: '', migrations: [{ name: 'schema_v1', status: 'skipped' }] })
    expect(schemaSnapshot(sqlite)).toEqual(before)
    expect(ledgerRows(sqlite)).toEqual(['schema_v1'])
  })

  it('names the ledger after the effective prefix, case preserved', async () => {
    const { db, sqlite } = sqliteD1()
    const env: Envish = fakeEnv({ DB: db, TABLE_PREFIX: 'ZETA' })

    expect(migrationsTable(env)).toBe('_ZETA_schema_migrations')
    await runMigrations(env)

    expect(tableNames(sqlite)).toContain('_ZETA_schema_migrations')
    expect(ledgerRows(sqlite, '_ZETA_schema_migrations')).toEqual(['schema_v1'])
  })

  it('stops at the first failing migration, records nothing for it and runs nothing after it', async () => {
    const { db, sqlite } = sqliteD1()
    const env: Envish = fakeEnv({ DB: db, TABLE_PREFIX: '' })
    const migrations: Migration[] = [
      { name: 'schema_v1', sql: 'CREATE TABLE IF NOT EXISTS one (id TEXT)' },
      { name: 'schema_v2', sql: 'CREATE TABLE two (' }, // syntax error
      { name: 'schema_v3', sql: 'CREATE TABLE IF NOT EXISTS three (id TEXT)' },
    ]

    await expect(runMigrations(env, migrations)).rejects.toThrow(/Migration schema_v2 failed and was not recorded/)

    expect(ledgerRows(sqlite)).toEqual(['schema_v1'])
    expect(tableNames(sqlite)).toContain('one')
    expect(tableNames(sqlite)).not.toContain('two')
    expect(tableNames(sqlite)).not.toContain('three')

    // A later, fixed run resumes exactly at the failed migration
    const fixed = [{ ...migrations[1]!, sql: 'CREATE TABLE IF NOT EXISTS two (id TEXT)' }, migrations[2]!]
    expect((await runMigrations(env, fixed)).migrations).toEqual([
      { name: 'schema_v2', status: 'applied' },
      { name: 'schema_v3', status: 'applied' },
    ])
    expect(ledgerRows(sqlite)).toEqual(['schema_v1', 'schema_v2', 'schema_v3'])
  })

  it('records a migration only after its SQL succeeded', async () => {
    const { db, sqlite } = sqliteD1()
    const env: Envish = fakeEnv({ DB: db, TABLE_PREFIX: '' })
    // A migration that creates one table and then fails must not be recorded, so a fixed rerun
    // replays it as a whole.
    await expect(
      runMigrations(env, [{ name: 'schema_v1', sql: 'CREATE TABLE IF NOT EXISTS one (id TEXT);\nBROKEN SQL' }])
    ).rejects.toThrow(/schema_v1 failed and was not recorded/)
    expect(ledgerRows(sqlite)).toEqual([])
  })

  it('applies migrations in order', async () => {
    const { db, sqlite } = sqliteD1()
    const env: Envish = fakeEnv({ DB: db, TABLE_PREFIX: '' })

    const result = await runMigrations(env, TEST_MIGRATIONS)

    expect(result.migrations).toEqual([
      { name: 'schema_v1', status: 'applied' },
      { name: 'schema_v2', status: 'applied' },
    ])
    expect(ledgerRows(sqlite)).toEqual(['schema_v1', 'schema_v2'])
  })
})

describe('runMigrations anti-silent-switch guard', () => {
  it('refuses to migrate when the schema already lives under another prefix', async () => {
    const { db, sqlite } = sqliteD1()
    const seeded = fakeEnv({ DB: db, TABLE_PREFIX: 'ZETA' })
    await runMigrations(seeded)
    const before = schemaSnapshot(sqlite)

    const switched: Envish = fakeEnv({ DB: db, TABLE_PREFIX: undefined }) // resolves to zeta_
    await expect(runMigrations(switched)).rejects.toBeInstanceOf(TablePrefixConflictError)
    await expect(runMigrations(switched)).rejects.toThrow(/set TABLE_PREFIX=ZETA/)

    // Nothing was created under the new prefix and nothing was touched
    expect(schemaSnapshot(sqlite)).toEqual(before)
    expect(tableNames(sqlite).filter((name) => name.startsWith('zeta_'))).toEqual([])
  })

  it('allows an incremental run when the resolved prefix matches the existing schema', async () => {
    const { db, sqlite } = sqliteD1()
    const env: Envish = fakeEnv({ DB: db, TABLE_PREFIX: 'ZETA' })
    await runMigrations(env)
    const before = schemaSnapshot(sqlite)

    expect((await runMigrations(env)).migrations).toEqual([{ name: 'schema_v1', status: 'skipped' }])
    expect(schemaSnapshot(sqlite)).toEqual(before)
  })

  it('does not block on another project’s ledger in the same database', async () => {
    const { db, sqlite } = sqliteD1()
    // A sibling project in the shared D1 uses the same ledger convention under its own prefix
    sqlite.exec(`
      CREATE TABLE _SL_schema_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL DEFAULT (unixepoch()));
      INSERT INTO _SL_schema_migrations (name) VALUES ('schema_v1');
      CREATE TABLE SL_links (id TEXT PRIMARY KEY);
    `)
    const env: Envish = fakeEnv({ DB: db, TABLE_PREFIX: 'ZETA' })

    expect((await runMigrations(env)).migrations).toEqual([{ name: 'schema_v1', status: 'applied' }])
    expect(tableNames(sqlite)).toEqual(expect.arrayContaining(['SL_links', '_SL_schema_migrations']))
    expect(ledgerRows(sqlite, '_SL_schema_migrations')).toEqual(['schema_v1'])
  })

  it('refuses when its own ledger recorded migrations but the tables are gone', async () => {
    const { db, sqlite } = sqliteD1()
    sqlite.exec(`
      CREATE TABLE _ZETA_schema_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL DEFAULT (unixepoch()));
      INSERT INTO _ZETA_schema_migrations (name) VALUES ('schema_v1');
    `)
    const env: Envish = fakeEnv({ DB: db, TABLE_PREFIX: 'ZETA' })

    await expect(runMigrations(env)).rejects.toThrow(/drop _ZETA_schema_migrations as well/)
    expect(tableNames(sqlite)).toEqual(['_ZETA_schema_migrations'])
  })

  it('still migrates when the leftover ledger is empty (a failed run left nothing behind)', async () => {
    const { db, sqlite } = sqliteD1()
    sqlite.exec(
      'CREATE TABLE _ZETA_schema_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL DEFAULT (unixepoch()))'
    )
    const env: Envish = fakeEnv({ DB: db, TABLE_PREFIX: 'ZETA' })

    expect((await runMigrations(env)).migrations).toEqual([{ name: 'schema_v1', status: 'applied' }])
    expect(ledgerRows(sqlite, '_ZETA_schema_migrations')).toEqual(['schema_v1'])
  })
})
