import { describe, it, expect } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import prefixGuard from '../../../migrations/0000_prefix_guard.sql?raw'
import { tables } from '../../lib/db'
import { sqliteD1 } from './sqlite-d1'

// The migration-path half of the anti-silent-switch guard: 0000_prefix_guard.sql runs before
// 0001_init.sql whenever `wrangler d1 migrations apply` executes it, and refuses on databases
// that already host an initialised Zeta schema elsewhere (a setup-created prefixed deployment,
// or a setup-created unprefixed one). wrangler wraps each migration in a transaction, so a
// refused migration leaves nothing behind — applyGuard() reproduces that exactly.

const names = (sqlite: DatabaseSync) =>
  (sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(
    (r) => r.name
  )

const applyGuard = (sqlite: DatabaseSync) => {
  sqlite.exec('BEGIN')
  try {
    sqlite.exec(prefixGuard)
    sqlite.exec('COMMIT')
  } catch (err) {
    sqlite.exec('ROLLBACK')
    throw err
  }
}

// The wrangler d1 migrations flow creates the tracking table before running any migration, so
// it exists (possibly empty) by the time the guard executes — reproduce that precondition here.
const D1_MIGRATIONS_DDL =
  'CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, ' +
  'applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)'

const tracked = () => {
  const { db, sqlite } = sqliteD1()
  sqlite.exec(D1_MIGRATIONS_DDL)
  return { db, sqlite }
}

// An initialised Zeta family under a TABLE_PREFIX value, with minimal one-column tables
const createFamily = (sqlite: DatabaseSync, value: string, count = 11) => {
  for (const name of Object.values(tables({ TABLE_PREFIX: value })).slice(0, count)) {
    sqlite.exec(`CREATE TABLE ${name} (id TEXT PRIMARY KEY)`)
  }
}

const createForeign = (sqlite: DatabaseSync) => {
  sqlite.exec(`
    CREATE TABLE SL_perm (id TEXT);
    CREATE TABLE eNotify_queue (id TEXT);
    CREATE TABLE TP_logs (id TEXT);
    CREATE TABLE YL_data (id TEXT);
    CREATE TABLE TEMP_scratch (id TEXT);
    CREATE TABLE eNotify_users (id TEXT);
    CREATE TABLE SL_settings (id TEXT);
  `)
}

describe('migrations/0000_prefix_guard.sql', () => {
  it('passes on an empty database and leaves no trace', () => {
    const { sqlite } = tracked()
    expect(() => applyGuard(sqlite)).not.toThrow()
    expect(names(sqlite)).toEqual(['d1_migrations', 'sqlite_sequence'])
  })

  it('refuses on an initialised ZETA_-prefixed schema and changes nothing', () => {
    const { sqlite } = tracked()
    createFamily(sqlite, 'ZETA')
    const before = names(sqlite)

    expect(() => applyGuard(sqlite)).toThrow(/REFUSED.*initialised Zeta schema under a table prefix/s)

    // The refused migration is rolled back whole: no guard table, no Zeta tables touched,
    // no migrations recorded
    expect(names(sqlite)).toEqual(before)
    expect((sqlite.prepare('SELECT count(*) AS n FROM d1_migrations').all() as Array<{ n: number }>)[0]).toEqual({
      n: 0,
    })
  })

  it('refuses regardless of the prefix the existing family uses', () => {
    const { sqlite } = tracked()
    createFamily(sqlite, 'kp')
    expect(() => applyGuard(sqlite)).toThrow(/REFUSED.*table prefix/s)
    expect(names(sqlite).filter((n) => n.includes('guard'))).toEqual([])
  })

  it('refuses on an unprefixed setup-created schema (no migrations recorded)', () => {
    const { sqlite } = tracked()
    createFamily(sqlite, '')
    expect(() => applyGuard(sqlite)).toThrow(/REFUSED.*unprefixed Zeta schema.*d1_migrations records none/s)
    expect(names(sqlite).filter((n) => n.includes('guard'))).toEqual([])
  })

  it('passes on an unprefixed schema created by earlier migrations (d1_migrations records them)', () => {
    const { sqlite } = tracked()
    createFamily(sqlite, '')
    sqlite.exec("INSERT INTO d1_migrations (name) VALUES ('0001_init.sql')")
    const before = names(sqlite)
    expect(() => applyGuard(sqlite)).not.toThrow()
    expect(names(sqlite)).toEqual(before)
  })

  it('passes on a database shared with other projects, and never touches their tables', () => {
    const { sqlite } = tracked()
    createForeign(sqlite)
    expect(() => applyGuard(sqlite)).not.toThrow()
    expect(names(sqlite)).toContain('SL_perm')
    expect(names(sqlite)).toContain('eNotify_users')
    expect(names(sqlite)).toContain('SL_settings')
  })

  it('refuses on a prefixed schema even when the database is shared with other projects', () => {
    const { sqlite } = tracked()
    createForeign(sqlite)
    createFamily(sqlite, 'ZETA')
    expect(() => applyGuard(sqlite)).toThrow(/REFUSED.*table prefix/s)
    expect(names(sqlite)).toContain('SL_perm')
    expect(names(sqlite)).toContain('ZETA_users')
  })

  it('passes on a partial sub-threshold family (below 9 of the 11 tables)', () => {
    const { sqlite } = tracked()
    createFamily(sqlite, 'OLD', 3)
    expect(() => applyGuard(sqlite)).not.toThrow()
    expect(names(sqlite)).toContain('OLD_users')
  })
})
