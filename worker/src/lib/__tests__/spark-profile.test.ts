import { describe, expect, it } from 'vitest'
import { fakeEnv } from '../../routes/__tests__/fakes'
import { sqliteD1 } from '../../routes/__tests__/sqlite-d1'
import type { Env } from '../../types'
import { getMigrations } from '../migrations'
import {
  entriesToConfig,
  loadProfileConfig,
  MAX_PROFILE_ENTRIES,
  MAX_PROFILE_KEY_LENGTH,
  MAX_PROFILE_VALUE_LENGTH,
  parseStoredEntries,
  validateProfileEntries,
} from '../spark-profile'

const entry = (key: string, value: string) => ({ key, value })

describe('validateProfileEntries', () => {
  it('accepts runtime spark.sql.* keys and returns the trimmed entries', () => {
    const result = validateProfileEntries([
      entry(' spark.sql.shuffle.partitions ', ' 1000 '),
      entry('spark.sql.ansi.enabled', 'true'),
    ])
    expect(result).toEqual({
      ok: true,
      entries: [
        { key: 'spark.sql.shuffle.partitions', value: '1000' },
        { key: 'spark.sql.ansi.enabled', value: 'true' },
      ],
    })
  })

  it('drops blank lines (both key and value empty)', () => {
    const result = validateProfileEntries([
      entry('spark.sql.shuffle.partitions', '1000'),
      entry('', ''),
      entry('   ', '   '),
    ])
    expect(result).toEqual({ ok: true, entries: [{ key: 'spark.sql.shuffle.partitions', value: '1000' }] })
  })

  it('rejects a line with only a key or only a value as invalid_key', () => {
    expect(validateProfileEntries([entry('spark.sql.shuffle.partitions', '')])).toEqual({
      ok: false,
      kind: 'key',
      code: 'invalid_key',
      key: 'spark.sql.shuffle.partitions',
    })
    expect(validateProfileEntries([entry('', '1000')])).toEqual({
      ok: false,
      kind: 'key',
      code: 'invalid_key',
      key: '',
    })
  })

  it('rejects the three startup-level static keys', () => {
    for (const key of ['spark.sql.extensions', 'spark.sql.warehouse.dir', 'spark.sql.catalog.spark_catalog']) {
      expect(validateProfileEntries([entry(key, 'x')])).toMatchObject({
        ok: false,
        kind: 'key',
        code: 'startup_key_in_profile',
        key,
      })
    }
  })

  it('rejects any non-spark.sql. spark.* key as startup-level', () => {
    expect(validateProfileEntries([entry('spark.driver.memory', '4g')])).toMatchObject({
      ok: false,
      kind: 'key',
      code: 'startup_key_in_profile',
      key: 'spark.driver.memory',
    })
  })

  it('rejects a key outside the spark.* family as invalid_key', () => {
    expect(validateProfileEntries([entry('foo.bar', '1')])).toMatchObject({
      ok: false,
      kind: 'key',
      code: 'invalid_key',
      key: 'foo.bar',
    })
    expect(validateProfileEntries([entry('spark.sql', '1')])).toMatchObject({
      ok: false,
      kind: 'key',
      code: 'startup_key_in_profile',
    })
  })

  it('rejects a key or value over the §3 length limits', () => {
    expect(validateProfileEntries([entry(`spark.sql.${'a'.repeat(MAX_PROFILE_KEY_LENGTH)}`, '1')])).toMatchObject({
      ok: false,
      kind: 'key',
      code: 'invalid_key',
    })
    expect(
      validateProfileEntries([entry('spark.sql.ansi.enabled', 'x'.repeat(MAX_PROFILE_VALUE_LENGTH + 1))])
    ).toMatchObject({ ok: false, kind: 'key', code: 'invalid_key' })
  })

  it('rejects a duplicate key within one profile', () => {
    expect(
      validateProfileEntries([
        entry('spark.sql.shuffle.partitions', '1000'),
        entry('spark.sql.shuffle.partitions', '2000'),
      ])
    ).toMatchObject({ ok: false, kind: 'key', code: 'invalid_key', key: 'spark.sql.shuffle.partitions' })
  })

  it('rejects a non-array and a malformed entry', () => {
    expect(validateProfileEntries('nope')).toEqual({ ok: false, kind: 'key', code: 'invalid_key', key: '' })
    expect(validateProfileEntries([{ key: 1, value: 'x' }])).toEqual({
      ok: false,
      kind: 'key',
      code: 'invalid_key',
      key: '',
    })
  })

  it('rejects more than the entry-count limit', () => {
    const tooMany = Array.from({ length: MAX_PROFILE_ENTRIES + 1 }, (_, i) => entry(`spark.sql.k${i}`, `${i}`))
    expect(validateProfileEntries(tooMany)).toEqual({ ok: false, kind: 'limit', error: expect.any(String) })
  })
})

describe('entriesToConfig / parseStoredEntries', () => {
  it('turns entries into a config object', () => {
    expect(
      entriesToConfig([
        { key: 'a', value: '1' },
        { key: 'b', value: '2' },
      ])
    ).toEqual({ a: '1', b: '2' })
  })

  it('parses stored entries and tolerates a corrupt row', () => {
    expect(parseStoredEntries('[{"key":"a","value":"1"}]')).toEqual([{ key: 'a', value: '1' }])
    expect(parseStoredEntries('not json')).toEqual([])
    expect(parseStoredEntries('{"a":"1"}')).toEqual([])
  })
})

describe('loadProfileConfig', () => {
  function envWithDb(): { env: Env; app: ReturnType<typeof sqliteD1> } {
    const app = sqliteD1()
    for (const migration of getMigrations({ TABLE_PREFIX: '' })) app.sqlite.exec(migration.sql)
    app.sqlite.exec(`
      INSERT INTO users (id, email, name, role, created_at, updated_at)
        VALUES ('u1', 'u1@x.test', 'U1', 'member', 0, 0),
               ('u2', 'u2@x.test', 'U2', 'member', 0, 0);
      INSERT INTO d1_databases (id, name, binding_name, kind, is_active, created_at)
        VALUES ('sp1', 'spark', 'spark:sp1', 'spark', 1, 0);
    `)
    return { env: fakeEnv({ DB: app.db }), app }
  }

  const seed = (app: ReturnType<typeof sqliteD1>) =>
    app.sqlite.exec(`
      INSERT INTO spark_config_profiles (id, user_id, database_id, name, entries, created_at, updated_at)
      VALUES ('p1', 'u1', 'sp1', 'mine', '[{"key":"spark.sql.shuffle.partitions","value":"1000"}]', 0, 0),
             ('p2', 'u2', 'sp1', 'other', '[{"key":"spark.sql.ansi.enabled","value":"true"}]', 0, 0),
             ('p3', 'u1', 'sp1', 'corrupt', 'not json', 0, 0)
    `)

  it("resolves the caller's own profile to a config object", async () => {
    const { env, app } = envWithDb()
    seed(app)
    await expect(loadProfileConfig(env, 'u1', 'sp1', 'p1')).resolves.toEqual({
      'spark.sql.shuffle.partitions': '1000',
    })
  })

  it('returns null for an unknown, blank or foreign profile id without leaking existence', async () => {
    const { env, app } = envWithDb()
    seed(app)
    await expect(loadProfileConfig(env, 'u1', 'sp1', 'nope')).resolves.toBeNull()
    await expect(loadProfileConfig(env, 'u1', 'sp1', '')).resolves.toBeNull()
    await expect(loadProfileConfig(env, 'u1', 'sp1', undefined)).resolves.toBeNull()
    // p2 exists but belongs to another user
    await expect(loadProfileConfig(env, 'u1', 'sp1', 'p2')).resolves.toBeNull()
  })

  it('returns null when the stored entries no longer parse to anything usable', async () => {
    const { env, app } = envWithDb()
    seed(app)
    await expect(loadProfileConfig(env, 'u1', 'sp1', 'p3')).resolves.toBeNull()
  })
})
