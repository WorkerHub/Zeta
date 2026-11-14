import { describe, expect, it } from 'vitest'
import { getMigrations } from '../../lib/migrations'
import type { Env } from '../../types'
import { bearer, callWorker, fakeEnv } from './fakes'
import { sqliteD1 } from './sqlite-d1'

// Personal Spark config profiles (SPEC §5.1/§5.2/§4): CRUD, the save-time validation, the §3
// limits, the per-user filtering, and the coexistence of the two /api/databases sub-apps.

async function sparkEnv() {
  const app = sqliteD1()
  for (const migration of getMigrations({ TABLE_PREFIX: '' })) app.sqlite.exec(migration.sql)
  const env = fakeEnv({ DB: app.db })
  app.sqlite.exec(`
    INSERT INTO users (id, email, name, role, created_at, updated_at)
      VALUES ('u1', 'member@example.com', 'Member', 'member', 0, 0),
             ('u2', 'other@example.com', 'Other', 'member', 0, 0),
             ('a1', 'admin@example.com', 'Admin', 'admin', 0, 0);
    INSERT INTO d1_databases (id, name, binding_name, kind, is_active, created_at)
      VALUES ('sp1', 'spark', 'spark:sp1', 'spark', 1, 0),
             ('d1', 'local', 'cf:d1', 'sqlite', 1, 0);
    INSERT INTO user_database_permissions (id, user_id, database_id, permission, granted_at)
      VALUES ('p1', 'u1', 'sp1', 'read', 0);
  `)
  return { env, app }
}

const req = (env: Env, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
  callWorker(env, path, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })

const entries = [{ key: 'spark.sql.shuffle.partitions', value: '1000' }]

describe('personal Spark profiles', () => {
  it('lists only the caller\u2019s own profiles with id, name, entries and updated_at', async () => {
    const { env, app } = await sparkEnv()
    app.sqlite.exec(`
      INSERT INTO spark_config_profiles (id, user_id, database_id, name, entries, created_at, updated_at)
      VALUES ('p1', 'u1', 'sp1', 'mine', '[{"key":"spark.sql.shuffle.partitions","value":"1000"}]', 0, 10),
             ('p2', 'u2', 'sp1', 'other', '[{"key":"spark.sql.ansi.enabled","value":"true"}]', 0, 20)
    `)
    const res = await req(env, 'GET', '/api/databases/sp1/spark-profiles', undefined, await bearer(env, 'u1'))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { results: Array<Record<string, unknown>> }
    expect(body.results).toEqual([
      { id: 'p1', name: 'mine', entries: [{ key: 'spark.sql.shuffle.partitions', value: '1000' }], updated_at: 10 },
    ])
  })

  it('creates a profile and answers 201 with the stored shape', async () => {
    const { env } = await sparkEnv()
    const res = await req(
      env,
      'POST',
      '/api/databases/sp1/spark-profiles',
      { name: 'mine', entries },
      await bearer(env, 'u1')
    )
    expect(res.status).toBe(201)
    const body = (await res.json()) as { id: string; name: string; entries: unknown }
    expect(body.id).toBeTruthy()
    expect(body.name).toBe('mine')
    expect(body.entries).toEqual(entries)
  })

  it('drops blank lines when saving', async () => {
    const { env, app } = await sparkEnv()
    const res = await req(
      env,
      'POST',
      '/api/databases/sp1/spark-profiles',
      { name: 'mine', entries: [...entries, { key: '', value: '' }] },
      await bearer(env, 'u1')
    )
    expect(res.status).toBe(201)
    const stored = app.sqlite.prepare('SELECT entries FROM spark_config_profiles').all() as Array<{ entries: string }>
    expect(JSON.parse(stored[0]!.entries)).toEqual(entries)
  })

  it('refuses a non-Spark target, an unknown database, and a member without access', async () => {
    const { env } = await sparkEnv()
    const notSpark = await req(
      env,
      'POST',
      '/api/databases/d1/spark-profiles',
      { name: 'x', entries },
      await bearer(env, 'a1', 'admin')
    )
    expect(notSpark.status).toBe(400)
    expect(((await notSpark.json()) as { error: string }).error).toContain('SparkSQL')

    const missing = await req(
      env,
      'GET',
      '/api/databases/nope/spark-profiles',
      undefined,
      await bearer(env, 'a1', 'admin')
    )
    expect(missing.status).toBe(404)

    const denied = await req(env, 'GET', '/api/databases/sp1/spark-profiles', undefined, await bearer(env, 'u2'))
    expect(denied.status).toBe(403)
  })

  it('rejects a startup-level key and an invalid key, naming the key', async () => {
    const { env } = await sparkEnv()
    const startup = await req(
      env,
      'POST',
      '/api/databases/sp1/spark-profiles',
      { name: 'x', entries: [{ key: 'spark.sql.extensions', value: 'x' }] },
      await bearer(env, 'u1')
    )
    expect(startup.status).toBe(400)
    expect(await startup.json()).toMatchObject({ code: 'startup_key_in_profile', key: 'spark.sql.extensions' })

    const invalid = await req(
      env,
      'POST',
      '/api/databases/sp1/spark-profiles',
      { name: 'x', entries: [{ key: 'foo.bar', value: '1' }] },
      await bearer(env, 'u1')
    )
    expect(invalid.status).toBe(400)
    expect(await invalid.json()).toMatchObject({ code: 'invalid_key', key: 'foo.bar' })
  })

  it('rejects a duplicate name and names the conflict', async () => {
    const { env, app } = await sparkEnv()
    app.sqlite.exec(
      `INSERT INTO spark_config_profiles (id, user_id, database_id, name, entries, created_at, updated_at) VALUES ('p1', 'u1', 'sp1', 'mine', '[]', 0, 0)`
    )
    const res = await req(
      env,
      'POST',
      '/api/databases/sp1/spark-profiles',
      { name: 'mine', entries },
      await bearer(env, 'u1')
    )
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ name: 'mine' })
  })

  it('enforces the per-user 20-profile limit', async () => {
    const { env, app } = await sparkEnv()
    for (let i = 0; i < 20; i++) {
      app.sqlite.exec(
        `INSERT INTO spark_config_profiles (id, user_id, database_id, name, entries, created_at, updated_at) VALUES ('p${i}', 'u1', 'sp1', 'n${i}', '[]', 0, 0)`
      )
    }
    const res = await req(
      env,
      'POST',
      '/api/databases/sp1/spark-profiles',
      { name: 'overflow', entries },
      await bearer(env, 'u1')
    )
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toContain('20')
  })

  it('updates a profile and lets a rename to its own name pass', async () => {
    const { env, app } = await sparkEnv()
    app.sqlite.exec(
      `INSERT INTO spark_config_profiles (id, user_id, database_id, name, entries, created_at, updated_at) VALUES ('p1', 'u1', 'sp1', 'mine', '[]', 0, 0)`
    )
    // Rename to the same name: must not trip the uniqueness check.
    const same = await req(
      env,
      'PUT',
      '/api/databases/sp1/spark-profiles/p1',
      { name: 'mine' },
      await bearer(env, 'u1')
    )
    expect(same.status).toBe(200)

    const renamed = await req(
      env,
      'PUT',
      '/api/databases/sp1/spark-profiles/p1',
      { name: 'renamed', entries },
      await bearer(env, 'u1')
    )
    expect(renamed.status).toBe(200)
    const row = app.sqlite.prepare("SELECT name, entries FROM spark_config_profiles WHERE id = 'p1'").all() as Array<{
      name: string
      entries: string
    }>
    expect(row[0]!.name).toBe('renamed')
    expect(JSON.parse(row[0]!.entries)).toEqual(entries)
  })

  it('rejects updating a profile that is not the caller\u2019s (404, no leak)', async () => {
    const { env, app } = await sparkEnv()
    app.sqlite.exec(
      `INSERT INTO spark_config_profiles (id, user_id, database_id, name, entries, created_at, updated_at) VALUES ('p1', 'u2', 'sp1', 'other', '[]', 0, 0)`
    )
    const res = await req(env, 'PUT', '/api/databases/sp1/spark-profiles/p1', { name: 'x' }, await bearer(env, 'u1'))
    expect(res.status).toBe(404)
  })

  it('deletes only the caller\u2019s own profile', async () => {
    const { env, app } = await sparkEnv()
    app.sqlite.exec(
      `INSERT INTO spark_config_profiles (id, user_id, database_id, name, entries, created_at, updated_at) VALUES ('p1', 'u1', 'sp1', 'mine', '[]', 0, 0), ('p2', 'u2', 'sp1', 'other', '[]', 0, 0)`
    )
    const own = await req(env, 'DELETE', '/api/databases/sp1/spark-profiles/p1', undefined, await bearer(env, 'u1'))
    expect(own.status).toBe(200)

    const foreign = await req(env, 'DELETE', '/api/databases/sp1/spark-profiles/p2', undefined, await bearer(env, 'u1'))
    expect(foreign.status).toBe(404)
  })

  it('coexists with the database list on the same /api/databases prefix', async () => {
    const { env } = await sparkEnv()
    const list = await req(env, 'GET', '/api/databases', undefined, await bearer(env, 'u1'))
    expect(list.status).toBe(200)

    const profiles = await req(env, 'GET', '/api/databases/sp1/spark-profiles', undefined, await bearer(env, 'u1'))
    expect(profiles.status).toBe(200)
    expect(await profiles.json()).toEqual({ results: [] })
  })
})
