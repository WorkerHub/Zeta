import { describe, expect, it } from 'vitest'
import { getMigrations } from '../../lib/migrations'
import { runMigrations } from '../../lib/migrations-runner'
import type { Env } from '../../types'
import { bearer, callWorker, fakeEnv } from './fakes'
import { sqliteD1 } from './sqlite-d1'

// Real SQLite (sqliteD1), so the statements — and a database that has not run schema_v6 yet, whose
// users table really has no theme_color — behave exactly like the deployment. An unprefixed
// deployment keeps the expected SQL readable.

const migrations = getMigrations({ TABLE_PREFIX: '' })

const upTo = (name: string) => migrations.slice(0, migrations.findIndex((m) => m.name === name) + 1)

const SEED_USER = `INSERT INTO users (id, email, name, role, created_at, updated_at)
  VALUES ('u1', 'u@example.com', 'U', 'member', 0, 0)`

// The upgrade landed: users carries theme_color, and the account exists.
async function upgraded() {
  const { db, sqlite } = sqliteD1()
  const env: Env = fakeEnv({ DB: db })
  await runMigrations(env)
  sqlite.exec(SEED_USER)
  return { env, sqlite }
}

// The window between a deploy and the admin's upgrade: everything up to schema_v5, so the column is
// genuinely missing — the requests have to answer around it.
async function beforeUpgrade() {
  const { db, sqlite } = sqliteD1()
  const env: Env = fakeEnv({ DB: db })
  await runMigrations(env, upTo('schema_v5'))
  sqlite.exec(SEED_USER)
  return { env, sqlite }
}

const putTheme = (body: unknown, headers: Record<string, string>): RequestInit => ({
  method: 'PUT',
  headers: { 'Content-Type': 'application/json', ...headers },
  body: JSON.stringify(body),
})

const storedTheme = (sqlite: ReturnType<typeof sqliteD1>['sqlite']) =>
  (sqlite.prepare(`SELECT theme_color FROM users WHERE id = 'u1'`).all()[0] as { theme_color: string | null })
    .theme_color

const storedUpdatedAt = (sqlite: ReturnType<typeof sqliteD1>['sqlite']) =>
  (sqlite.prepare(`SELECT updated_at FROM users WHERE id = 'u1'`).all()[0] as { updated_at: number }).updated_at

describe('GET /api/profile/theme-color', () => {
  it('reports null for an account that never set one', async () => {
    const { env } = await upgraded()
    const res = await callWorker(env, '/api/profile/theme-color', { headers: await bearer(env, 'u1') })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ theme_color: null })
  })

  it('reports the stored preset', async () => {
    const { env, sqlite } = await upgraded()
    sqlite.exec(`UPDATE users SET theme_color = 'grape' WHERE id = 'u1'`)
    const res = await callWorker(env, '/api/profile/theme-color', { headers: await bearer(env, 'u1') })
    expect(await res.json()).toEqual({ theme_color: 'grape' })
  })

  it('reads an id this API does not know as "never set" instead of passing it on', async () => {
    const { env, sqlite } = await upgraded()
    // A hand-edited row, or a preset that was removed
    sqlite.exec(`UPDATE users SET theme_color = 'blue' WHERE id = 'u1'`)
    const res = await callWorker(env, '/api/profile/theme-color', { headers: await bearer(env, 'u1') })
    expect(await res.json()).toEqual({ theme_color: null })
  })

  it('requires a session', async () => {
    const { env } = await upgraded()
    expect((await callWorker(env, '/api/profile/theme-color')).status).toBe(401)
  })
})

describe('PUT /api/profile/theme-color', () => {
  it('stores a preset and moves updated_at', async () => {
    const { env, sqlite } = await upgraded()
    const res = await callWorker(
      env,
      '/api/profile/theme-color',
      putTheme({ theme_color: 'ocean' }, await bearer(env, 'u1'))
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ theme_color: 'ocean' })
    expect(storedTheme(sqlite)).toBe('ocean')
    expect(storedUpdatedAt(sqlite)).toBeGreaterThan(0)
  })

  it('keeps the default preset as a stored id, not as null', async () => {
    const { env, sqlite } = await upgraded()
    const res = await callWorker(
      env,
      '/api/profile/theme-color',
      putTheme({ theme_color: 'terracotta' }, await bearer(env, 'u1'))
    )
    expect(await res.json()).toEqual({ theme_color: 'terracotta' })
    expect(storedTheme(sqlite)).toBe('terracotta')
  })

  it('refuses anything that is not one of the six presets, writing nothing', async () => {
    const { env, sqlite } = await upgraded()
    const headers = await bearer(env, 'u1')
    const before = storedUpdatedAt(sqlite)
    for (const body of [
      { theme_color: 'blue' },
      { theme_color: 'Ocean' },
      { theme_color: '' },
      { theme_color: null },
      {},
      { theme_color: 42 },
    ]) {
      const res = await callWorker(env, '/api/profile/theme-color', putTheme(body, headers))
      expect(res.status).toBe(400)
      expect(typeof ((await res.json()) as { error?: unknown }).error).toBe('string')
    }
    expect(storedTheme(sqlite)).toBeNull()
    expect(storedUpdatedAt(sqlite)).toBe(before)
  })

  it('requires a session', async () => {
    const { env, sqlite } = await upgraded()
    expect((await callWorker(env, '/api/profile/theme-color', putTheme({ theme_color: 'ocean' }, {}))).status).toBe(401)
    expect(storedTheme(sqlite)).toBeNull()
  })

  it('is visible to GET /theme-color and to GET /me afterwards', async () => {
    const { env } = await upgraded()
    const headers = await bearer(env, 'u1')
    expect(
      (await callWorker(env, '/api/profile/theme-color', putTheme({ theme_color: 'forest' }, headers))).status
    ).toBe(200)

    expect(await (await callWorker(env, '/api/profile/theme-color', { headers })).json()).toEqual({
      theme_color: 'forest',
    })
    const me = (await (await callWorker(env, '/api/profile/me', { headers })).json()) as Record<string, unknown>
    expect(me.theme_color).toBe('forest')
    expect(me.email).toBe('u@example.com')
  })
})

describe('a database that has not run schema_v6 yet', () => {
  it('answers the read with null instead of failing', async () => {
    const { env } = await beforeUpgrade()
    const res = await callWorker(env, '/api/profile/theme-color', { headers: await bearer(env, 'u1') })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ theme_color: null })
  })

  it('answers the write with 503 and a readable reason, not a missing-column crash', async () => {
    const { env } = await beforeUpgrade()
    const res = await callWorker(
      env,
      '/api/profile/theme-color',
      putTheme({ theme_color: 'ocean' }, await bearer(env, 'u1'))
    )
    expect(res.status).toBe(503)
    const body = (await res.json()) as { error?: string }
    expect(body.error).toMatch(/database upgrade/i)
  })

  it('still returns the profile, with theme_color null, so signing in is never blocked', async () => {
    const { env } = await beforeUpgrade()
    const res = await callWorker(env, '/api/profile/me', { headers: await bearer(env, 'u1') })
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.theme_color).toBeNull()
    expect(body.email).toBe('u@example.com')
  })

  it('keeps working once the upgrade runs', async () => {
    const { env, sqlite } = await beforeUpgrade()
    const headers = await bearer(env, 'u1')
    expect(
      (await callWorker(env, '/api/profile/theme-color', putTheme({ theme_color: 'ocean' }, headers))).status
    ).toBe(503)

    await runMigrations(env)

    expect(
      (await callWorker(env, '/api/profile/theme-color', putTheme({ theme_color: 'ocean' }, headers))).status
    ).toBe(200)
    expect(storedTheme(sqlite)).toBe('ocean')
  })
})
