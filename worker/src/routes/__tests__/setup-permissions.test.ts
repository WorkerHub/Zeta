import { describe, it, expect } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import init from '../../../migrations/0001_init.sql?raw'
import historyNullable from '../../../migrations/0002_history_nullable_refs.sql?raw'
import rateLimits from '../../../migrations/0003_rate_limits_history_set_null.sql?raw'
import type { Env } from '../../types'
import { bearer, callWorker, fakeEnv, postJson } from './fakes'
import { sqliteD1 } from './sqlite-d1'

// Runs against a real SQLite database (foreign keys enforced, like D1) because the bug being
// repaired only shows up with real foreign-key checks.

const ADMIN = 'admin-1'
const MEMBER = 'member-1'

const rows = (sqlite: DatabaseSync, sql: string) => sqlite.prepare(sql).all() as Array<Record<string, unknown>>

const runSetup = async (env: Env) => {
  const res = await callWorker(env, '/api/setup', postJson({ secret: 'test-setup-secret' }))
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

const foreignKeys = (sqlite: DatabaseSync, table: string) =>
  rows(sqlite, `PRAGMA foreign_key_list(${table})`)
    .map((fk) => `${fk.from}->${fk.table}`)
    .sort()

const indexes = (sqlite: DatabaseSync) =>
  rows(sqlite, `SELECT name, tbl_name FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL ORDER BY name`).map(
    (r) => `${r.name} ON ${r.tbl_name}`
  )

// A database shaped like the affected production one: the tables of a prefixed setup, except that
// the permissions table references the unprefixed `users` / `d1_databases` (only `users` exists,
// owned by another project) and still carries the unprefixed 0001 indexes. Another project's
// table and index share the database. Permission rows: two valid ones (one granted by a user who
// no longer exists), one for a missing user and one for a missing database.
async function brokenPrefixedDatabase(prefix = 'ZETA') {
  const { db, sqlite } = sqliteD1()
  const env = fakeEnv({ DB: db, TABLE_PREFIX: prefix })
  expect((await runSetup(env)).status).toBe(200)
  const p = `${prefix}_`
  sqlite.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT);
    INSERT INTO users VALUES ('other-project-user', 'x@example.com');
    CREATE TABLE SL_perm (id TEXT PRIMARY KEY, user_id TEXT);
    CREATE INDEX idx_perm_user ON SL_perm(user_id);

    DROP TABLE ${p}user_database_permissions;
    CREATE TABLE "${p}user_database_permissions" ( id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, database_id TEXT NOT NULL REFERENCES d1_databases(id) ON DELETE CASCADE, permission TEXT NOT NULL DEFAULT 'read' CHECK (permission IN ('read', 'write', 'write_drop')), granted_by TEXT REFERENCES users(id), granted_at INTEGER NOT NULL, UNIQUE (user_id, database_id) );
    CREATE INDEX idx_perm_db ON ${p}user_database_permissions(database_id);
    CREATE INDEX idx_${p}user_database_permissions_user ON ${p}user_database_permissions(user_id);
    CREATE INDEX idx_${p}user_database_permissions_db ON ${p}user_database_permissions(database_id);

    INSERT INTO ${p}users (id, email, name, role, created_at, updated_at) VALUES
      ('${ADMIN}', 'admin@example.com', 'Admin', 'admin', 0, 0),
      ('${MEMBER}', 'member@example.com', 'Member', 'member', 0, 0);
    INSERT INTO ${p}d1_databases (id, name, binding_name, created_at) VALUES
      ('db-1', 'one', 'QUERY_DB_1', 0), ('db-2', 'two', 'QUERY_DB_2', 0);

    PRAGMA foreign_keys = OFF;
    INSERT INTO ${p}user_database_permissions VALUES
      ('p-valid', '${MEMBER}', 'db-1', 'write', '${ADMIN}', 1),
      ('p-gone-granter', '${ADMIN}', 'db-1', 'read', 'deleted-user', 2),
      ('p-gone-user', 'deleted-user', 'db-1', 'read', '${ADMIN}', 3),
      ('p-gone-db', '${MEMBER}', 'deleted-db', 'read', '${ADMIN}', 4);
    PRAGMA foreign_keys = ON;
  `)
  return { db, sqlite, env, p }
}

describe('setup repairs user_database_permissions foreign keys', () => {
  it('reproduces the production failure: granting a database fails before the repair', async () => {
    const { env } = await brokenPrefixedDatabase()
    const headers = await bearer(env, ADMIN, 'admin')
    const res = await callWorker(
      env,
      '/api/admin/databases/db-2/permissions/member-1',
      postJson({ permission: 'read' }, { method: 'PUT', headers })
    )
    expect(res.status).toBe(500)
  })

  it('rebuilds the table with prefixed foreign keys, keeping valid rows and dropping orphans', async () => {
    const { sqlite, env, p } = await brokenPrefixedDatabase()
    const { status, body } = await runSetup(env)
    expect(status).toBe(200)
    expect(body).toMatchObject({
      ok: true,
      permissionsRepair: { dropped: 2, clearedGrantedBy: 1 },
      upgraded: [expect.stringMatching(/ZETA_user_database_permissions: .*dropped 2 orphaned row/)],
    })

    expect(foreignKeys(sqlite, `${p}user_database_permissions`)).toEqual([
      'database_id->ZETA_d1_databases',
      'granted_by->ZETA_users',
      'user_id->ZETA_users',
    ])
    expect(
      rows(
        sqlite,
        `SELECT id, user_id, database_id, permission, granted_by, granted_at FROM ${p}user_database_permissions ORDER BY id`
      )
    ).toEqual([
      {
        id: 'p-gone-granter',
        user_id: ADMIN,
        database_id: 'db-1',
        permission: 'read',
        granted_by: null,
        granted_at: 2,
      },
      { id: 'p-valid', user_id: MEMBER, database_id: 'db-1', permission: 'write', granted_by: ADMIN, granted_at: 1 },
    ])

    const idx = indexes(sqlite)
    expect(idx).toContain('idx_ZETA_user_database_permissions_user ON ZETA_user_database_permissions')
    expect(idx).toContain('idx_ZETA_user_database_permissions_db ON ZETA_user_database_permissions')
    expect(idx.some((i) => i.startsWith('idx_perm_db '))).toBe(false)
    // Another project's index that happens to share a legacy name is left alone
    expect(idx).toContain('idx_perm_user ON SL_perm')
    // The unprefixed users table is not ours to drop, and no temporary table is left behind
    expect(rows(sqlite, 'SELECT id FROM users')).toEqual([{ id: 'other-project-user' }])
    expect(rows(sqlite, `SELECT name FROM sqlite_master WHERE name LIKE '%_new'`)).toEqual([])
  })

  it('is a no-op when run again after the repair', async () => {
    const { sqlite, env, p } = await brokenPrefixedDatabase()
    await runSetup(env)
    const before = rows(sqlite, `SELECT * FROM ${p}user_database_permissions ORDER BY id`)
    const schema = rows(sqlite, 'SELECT type, name, sql FROM sqlite_master ORDER BY name')

    const { status, body } = await runSetup(env)
    expect(status).toBe(200)
    expect(body).not.toHaveProperty('permissionsRepair')
    expect(body).not.toHaveProperty('upgraded')
    expect(rows(sqlite, `SELECT * FROM ${p}user_database_permissions ORDER BY id`)).toEqual(before)
    expect(rows(sqlite, 'SELECT type, name, sql FROM sqlite_master ORDER BY name')).toEqual(schema)
  })

  it('leaves a prefixed database with correct foreign keys untouched', async () => {
    const { db, sqlite } = sqliteD1()
    const env = fakeEnv({ DB: db, TABLE_PREFIX: 'kp' })
    await runSetup(env)
    const schema = rows(sqlite, 'SELECT type, name, sql FROM sqlite_master ORDER BY name')
    const { body } = await runSetup(env)
    expect(body).not.toHaveProperty('permissionsRepair')
    expect(foreignKeys(sqlite, 'kp_user_database_permissions')).toEqual([
      'database_id->kp_d1_databases',
      'granted_by->kp_users',
      'user_id->kp_users',
    ])
    expect(rows(sqlite, 'SELECT type, name, sql FROM sqlite_master ORDER BY name')).toEqual(schema)
  })

  it('leaves an unprefixed, migration-initialised database untouched (including its idx_perm_* indexes)', async () => {
    const { db, sqlite } = sqliteD1()
    sqlite.exec(init)
    sqlite.exec(historyNullable)
    sqlite.exec(rateLimits)
    sqlite.exec(`
      INSERT INTO users (id, email, name, role, created_at, updated_at) VALUES ('${MEMBER}', 'm@example.com', 'M', 'member', 0, 0);
      INSERT INTO d1_databases (id, name, binding_name, created_at) VALUES ('db-1', 'one', 'QUERY_DB_1', 0);
      INSERT INTO user_database_permissions VALUES ('p-1', '${MEMBER}', 'db-1', 'read', NULL, 1);
    `)
    const env = fakeEnv({ DB: db })
    const { status, body } = await runSetup(env)
    expect(status).toBe(200)
    expect(body).not.toHaveProperty('permissionsRepair')
    expect(rows(sqlite, 'SELECT id FROM user_database_permissions')).toEqual([{ id: 'p-1' }])
    const idx = indexes(sqlite)
    expect(idx).toContain('idx_perm_user ON user_database_permissions')
    expect(idx).toContain('idx_perm_db ON user_database_permissions')
  })

  it('rolls everything back when the rebuild fails part-way', async () => {
    const { sqlite, env, p } = await brokenPrefixedDatabase()
    // A view under the temporary table's name makes `DROP TABLE IF EXISTS <tmp>` fail mid-batch,
    // after the legacy index has already been dropped inside the transaction
    sqlite.exec(`CREATE VIEW ${p}user_database_permissions_new AS SELECT 1`)
    const schema = rows(sqlite, 'SELECT type, name, sql FROM sqlite_master ORDER BY name')

    const { status, body } = await runSetup(env)
    expect(status).toBe(500)
    expect(body).toMatchObject({ ok: false, errors: [expect.stringContaining('Upgrade error')] })
    expect(rows(sqlite, 'SELECT type, name, sql FROM sqlite_master ORDER BY name')).toEqual(schema)
    expect(rows(sqlite, `SELECT id FROM ${p}user_database_permissions ORDER BY id`)).toHaveLength(4)
    expect(foreignKeys(sqlite, `${p}user_database_permissions`)).toContain('database_id->d1_databases')
  })

  describe('after the repair', () => {
    const repaired = async () => {
      const ctx = await brokenPrefixedDatabase()
      expect((await runSetup(ctx.env)).status).toBe(200)
      return { ...ctx, headers: await bearer(ctx.env, ADMIN, 'admin') }
    }
    const grant = (env: Env, headers: Record<string, string>, dbId: string, userId: string) =>
      callWorker(
        env,
        `/api/admin/databases/${dbId}/permissions/${userId}`,
        postJson({ permission: 'read' }, { method: 'PUT', headers })
      )
    const permsOf = (sqlite: DatabaseSync, p: string) =>
      rows(sqlite, `SELECT user_id, database_id FROM ${p}user_database_permissions ORDER BY user_id, database_id`)

    it('grants and revokes database access', async () => {
      const { sqlite, env, p, headers } = await repaired()
      expect((await grant(env, headers, 'db-2', MEMBER)).status).toBe(200)
      expect(permsOf(sqlite, p)).toContainEqual({ user_id: MEMBER, database_id: 'db-2' })
      // A grant for a user or database that does not exist is rejected by the foreign keys
      expect((await grant(env, headers, 'db-2', 'no-such-user')).status).toBe(500)
      expect((await grant(env, headers, 'no-such-db', MEMBER)).status).toBe(500)

      const revoke = await callWorker(env, `/api/admin/databases/db-2/permissions/${MEMBER}`, {
        method: 'DELETE',
        headers,
      })
      expect(revoke.status).toBe(200)
      expect(permsOf(sqlite, p)).not.toContainEqual({ user_id: MEMBER, database_id: 'db-2' })
    })

    it('removes a deleted user’s and a deleted database’s permissions', async () => {
      const { sqlite, env, p, headers } = await repaired()
      await grant(env, headers, 'db-2', MEMBER)

      const delDb = await callWorker(env, '/api/admin/databases/db-1', { method: 'DELETE', headers })
      expect(delDb.status).toBe(200)
      expect(permsOf(sqlite, p)).toEqual([{ user_id: MEMBER, database_id: 'db-2' }])

      const delUser = await callWorker(env, `/api/admin/users/${MEMBER}`, { method: 'DELETE', headers })
      expect(delUser.status).toBe(200)
      expect(permsOf(sqlite, p)).toEqual([])
    })

    it('cascades deletes from the prefixed users and databases tables', async () => {
      const { sqlite, p } = await repaired()
      sqlite.exec(`INSERT INTO ${p}user_database_permissions VALUES ('p-2', '${MEMBER}', 'db-2', 'read', NULL, 5)`)

      sqlite.exec(`DELETE FROM ${p}d1_databases WHERE id = 'db-2'`)
      expect(permsOf(sqlite, p)).toEqual([
        { user_id: ADMIN, database_id: 'db-1' },
        { user_id: MEMBER, database_id: 'db-1' },
      ])

      sqlite.exec(`DELETE FROM ${p}users WHERE id = '${MEMBER}'`)
      expect(permsOf(sqlite, p)).toEqual([{ user_id: ADMIN, database_id: 'db-1' }])
    })
  })
})
