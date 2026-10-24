import { describe, it, expect } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import init from '../../../migrations/0001_init.sql?raw'
import { runSetup } from '../../lib/setup'
import { fakeEnv } from './fakes'
import { sqliteD1 } from './sqlite-d1'

// The anti-silent-switch guard of runSetup(): a D1 database that already holds an initialised
// Zeta table family under a prefix different from the resolved one must never be re-initialised
// under the new prefix — the guard refuses instead, and the message names the TABLE_PREFIX that
// keeps the existing tables. Everything runs against a real SQLite database so the schema really
// lands in sqlite_master, exactly like the production baseline (TABLE_PREFIX=ZETA, 11 ZETA_*
// tables) captured in ONE-213.

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
    sqlite.exec(init) // the migrations path: an unprefixed 9-table family
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
    sqlite.exec(init)
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

    // Even this adversarial leftover never causes a silent switch: the DDL fails (loudly, all in
    // one rolled-back batch) instead of initialising anything
    expect(result).toMatchObject({ ok: false })
    expect(names.filter((n) => n.startsWith('zeta_'))).toEqual([])
    expect(names).toEqual(['ZETA_users'])
  })

  it('initialises a fresh database under a custom prefix', async () => {
    const { db, sqlite } = sqliteD1()
    const { result, names } = await run(sqlite, fakeEnv({ DB: db, TABLE_PREFIX: 'kp' }))
    expect(result).toMatchObject({ ok: true, tablePrefix: 'kp_' })
    expect(names).toContain('kp_users')
  })
})
