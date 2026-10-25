import type { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { getMigrations } from '../../lib/migrations'
import { runSetup } from '../../lib/setup'
import { fakeEnv } from './fakes'
import { sqliteD1 } from './sqlite-d1'

// The anti-silent-switch guard of runSetup(): a D1 database that already holds an initialised
// Zeta table family under a prefix different from the resolved one must never be re-initialised
// under the new prefix — the guard refuses instead, and the message names the TABLE_PREFIX that
// keeps the existing tables. Everything runs against a real SQLite database so the schema really
// lands in sqlite_master, exactly like the production baseline (TABLE_PREFIX=ZETA, 11 ZETA_*
// tables) captured in ONE-213.

// The unprefixed schema_v1 as plain SQL: seeds an unprefixed Zeta schema directly, i.e. a database
// initialised before the migration ledger existed (no `_schema_migrations` row).
const unprefixedSchema = getMigrations({ TABLE_PREFIX: '' }).find((m) => m.name === 'schema_v1')!.sql

const tableNames = (sqlite: DatabaseSync) =>
  (
    sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
      name: string
    }>
  ).map((r) => r.name)

const run = async (sqlite: DatabaseSync, env: Parameters<typeof runSetup>[0]) => {
  const result = await runSetup(env)
  return { result, names: tableNames(sqlite) }
}

describe('runSetup anti-silent-switch guard', () => {
  it('refuses to re-initialise a ZETA_-prefixed database when TABLE_PREFIX became unset', async () => {
    const { db, sqlite } = sqliteD1()
    // The production baseline: a deployment initialised with TABLE_PREFIX=ZETA
    expect((await run(sqlite, fakeEnv({ DB: db, TABLE_PREFIX: 'ZETA' }))).result).toMatchObject({ ok: true })
    const before = tableNames(sqlite)

    // ...then the variable is lost: the resolved prefix silently becomes the default zeta_
    const { result, names } = await run(sqlite, fakeEnv({ DB: db, TABLE_PREFIX: undefined }))

    expect(result).toMatchObject({
      ok: false,
      errors: [
        expect.stringMatching(
          /table prefix ZETA_ \(11 tables\).*resolved table prefix is zeta_.*set TABLE_PREFIX=ZETA/s
        ),
      ],
    })
    // Nothing was initialised under the new prefix and nothing was touched
    expect(names.filter((n) => n.startsWith('zeta_'))).toEqual([])
    expect(names).toEqual(before)
  })

  it('keeps refusing while shared-database foreign tables are present, and never touches them', async () => {
    const { db, sqlite } = sqliteD1()
    expect((await run(sqlite, fakeEnv({ DB: db, TABLE_PREFIX: 'ZETA' }))).result).toMatchObject({ ok: true })
    sqlite.exec('CREATE TABLE SL_perm (id TEXT); CREATE TABLE eNotify_queue (id TEXT)')

    const { result, names } = await run(sqlite, fakeEnv({ DB: db, TABLE_PREFIX: undefined }))

    expect(result.ok).toBe(false)
    expect(names.filter((n) => n.startsWith('zeta_'))).toEqual([])
    expect(names).toContain('SL_perm')
    expect(names).toContain('eNotify_queue')
  })

  it('refuses when an unprefixed migration-created database meets an unset TABLE_PREFIX', async () => {
    const { db, sqlite } = sqliteD1()
    sqlite.exec(unprefixedSchema) // a pre-ledger, unprefixed 11-table family
    const before = tableNames(sqlite)

    const { result, names } = await run(sqlite, fakeEnv({ DB: db, TABLE_PREFIX: undefined }))

    expect(result).toMatchObject({
      ok: false,
      errors: [expect.stringContaining('set TABLE_PREFIX to an empty string (TABLE_PREFIX="")')],
    })
    expect(names.filter((n) => n.startsWith('zeta_'))).toEqual([])
    expect(names).toEqual(before)
  })

  it('refuses when the configured prefix only differs in case (never case-folded)', async () => {
    const { db, sqlite } = sqliteD1()
    expect((await run(sqlite, fakeEnv({ DB: db, TABLE_PREFIX: 'ZETA' }))).result).toMatchObject({ ok: true })

    const { result } = await run(sqlite, fakeEnv({ DB: db, TABLE_PREFIX: 'zeta' }))

    expect(result).toMatchObject({
      ok: false,
      errors: [expect.stringMatching(/table prefix ZETA_.*resolved table prefix is zeta_/s)],
    })
  })

  it('refuses when a differently prefixed family exists, whatever the configured value', async () => {
    const { db, sqlite } = sqliteD1()
    expect((await run(sqlite, fakeEnv({ DB: db, TABLE_PREFIX: 'ZETA' }))).result).toMatchObject({ ok: true })

    const { result, names } = await run(sqlite, fakeEnv({ DB: db, TABLE_PREFIX: 'kp' }))

    expect(result).toMatchObject({ ok: false, errors: [expect.stringContaining('set TABLE_PREFIX=ZETA')] })
    expect(names.filter((n) => n.startsWith('kp_'))).toEqual([])
  })

  it('re-runs normally when the resolved prefix matches the existing family', async () => {
    const { db, sqlite } = sqliteD1()
    expect((await run(sqlite, fakeEnv({ DB: db, TABLE_PREFIX: 'ZETA' }))).result).toMatchObject({ ok: true })
    const before = tableNames(sqlite)

    const { result, names } = await run(sqlite, fakeEnv({ DB: db, TABLE_PREFIX: 'ZETA' }))

    expect(result).toMatchObject({ ok: true, tablePrefix: 'ZETA_' })
    expect(names).toEqual(before)
  })

  it('reports the effective prefix for an unprefixed re-run (TABLE_PREFIX="")', async () => {
    const { db, sqlite } = sqliteD1()
    sqlite.exec(unprefixedSchema)
    const { result } = await run(sqlite, fakeEnv({ DB: db, TABLE_PREFIX: '' }))
    expect(result).toMatchObject({ ok: true, tablePrefix: '' })
    expect((await run(sqlite, fakeEnv({ DB: db, TABLE_PREFIX: '' }))).result).toMatchObject({ ok: true })
  })

  it('initialises a fresh database under the default prefix when TABLE_PREFIX is unset', async () => {
    const { db, sqlite } = sqliteD1()
    const { result, names } = await run(sqlite, fakeEnv({ DB: db, TABLE_PREFIX: undefined }))
    expect(result).toMatchObject({ ok: true, tablePrefix: 'zeta_' })
    expect(names).toContain('zeta_users')
    expect(names).toContain('zeta_rate_limits')
    expect(names).not.toContain('users')
  })

  it('initialises under the default prefix in a database shared with other projects', async () => {
    const { db, sqlite } = sqliteD1()
    sqlite.exec('CREATE TABLE SL_perm (id TEXT); CREATE TABLE eNotify_users (id TEXT)')

    const { result, names } = await run(sqlite, fakeEnv({ DB: db, TABLE_PREFIX: undefined }))

    expect(result).toMatchObject({ ok: true, tablePrefix: 'zeta_' })
    expect(names).toContain('zeta_users')
    // Foreign tables are left alone
    expect(names).toContain('SL_perm')
    expect(names).toContain('eNotify_users')
  })

  it('treats a sub-threshold partial family as a fresh database', async () => {
    const { db, sqlite } = sqliteD1()
    sqlite.exec('CREATE TABLE OLD_users (id TEXT); CREATE TABLE OLD_settings (key TEXT)')

    const { result, names } = await run(sqlite, fakeEnv({ DB: db, TABLE_PREFIX: undefined }))

    expect(result).toMatchObject({ ok: true, tablePrefix: 'zeta_' })
    expect(names).toContain('zeta_users')
    // The partial leftovers are not ours to touch
    expect(names).toContain('OLD_users')
    expect(names).toContain('OLD_settings')
  })

  it('fails loudly when a leftover table case-insensitively collides with the resolved prefix', async () => {
    const { db, sqlite } = sqliteD1()
    // SQLite matches table names case-insensitively, so zeta_users resolves to this ZETA_users
    sqlite.exec('CREATE TABLE ZETA_users (id TEXT)')

    const { result, names } = await run(sqlite, fakeEnv({ DB: db, TABLE_PREFIX: undefined }))

    // Even this adversarial leftover never causes a silent switch: the DDL fails loudly instead of
    // initialising anything. Only the (empty) ledger table it was reading from exists afterwards;
    // the next run applies the migrations again.
    expect(result).toMatchObject({ ok: false })
    expect(names.filter((n) => n.startsWith('zeta_'))).toEqual([])
    expect(names).toEqual(['ZETA_users', '_zeta_schema_migrations'])
  })

  it('initialises a fresh database under a custom prefix', async () => {
    const { db, sqlite } = sqliteD1()
    const { result, names } = await run(sqlite, fakeEnv({ DB: db, TABLE_PREFIX: 'kp' }))
    expect(result).toMatchObject({ ok: true, tablePrefix: 'kp_' })
    expect(names).toContain('kp_users')
  })

  it('mentions the migration ledger of the prefix that already owns the schema', async () => {
    const { db, sqlite } = sqliteD1()
    expect((await run(sqlite, fakeEnv({ DB: db, TABLE_PREFIX: 'ZETA' }))).result).toMatchObject({ ok: true })

    const { result } = await run(sqlite, fakeEnv({ DB: db, TABLE_PREFIX: undefined }))
    expect(result).toMatchObject({
      ok: false,
      errors: [expect.stringContaining('recorded in _ZETA_schema_migrations')],
    })
  })

  it('does not treat another project’s migration ledger as this project’s schema', async () => {
    const { db, sqlite } = sqliteD1()
    // A sibling project in the same shared D1 uses the same ledger convention under its own prefix
    sqlite.exec(`
      CREATE TABLE _SL_schema_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL DEFAULT (unixepoch()));
      INSERT INTO _SL_schema_migrations (name) VALUES ('schema_v1');
      CREATE TABLE SL_links (id TEXT PRIMARY KEY);
    `)

    const { result, names } = await run(sqlite, fakeEnv({ DB: db, TABLE_PREFIX: 'ZETA' }))

    expect(result).toMatchObject({ ok: true, tablePrefix: 'ZETA_', migrations: [{ status: 'applied' }] })
    expect(names).toContain('ZETA_users')
    expect(names).toContain('_ZETA_schema_migrations')
    // The foreign ledger and its tables are left alone
    expect(names).toContain('_SL_schema_migrations')
    expect(names).toContain('SL_links')
  })

  it('refuses when the resolved prefix has a ledger but the tables it recorded are gone', async () => {
    const { db, sqlite } = sqliteD1()
    sqlite.exec(`
      CREATE TABLE _ZETA_schema_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL DEFAULT (unixepoch()));
      INSERT INTO _ZETA_schema_migrations (name) VALUES ('schema_v1');
    `)

    const { result, names } = await run(sqlite, fakeEnv({ DB: db, TABLE_PREFIX: 'ZETA' }))

    expect(result).toMatchObject({
      ok: false,
      errors: [expect.stringMatching(/_ZETA_schema_migrations records .*drop _ZETA_schema_migrations as well/s)],
    })
    // Nothing was created: replaying the migrations would silently leave an incomplete schema
    expect(names).toEqual(['_ZETA_schema_migrations'])
  })
})
