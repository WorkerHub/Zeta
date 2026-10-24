import { afterEach, describe, expect, it, vi } from 'vitest'
import { bearer, callWorker, fakeD1, fakeEnv, postJson } from './fakes'
import { sqliteD1 } from './sqlite-d1'

afterEach(() => vi.unstubAllGlobals())

describe('POST /api/admin/settings/test-email', () => {
  it('rate-limits test emails per admin', async () => {
    const { db } = fakeD1()
    const env = fakeEnv({ DB: db })
    const headers = await bearer(env, 'admin-1', 'admin')
    const statuses: number[] = []
    for (let i = 0; i < 6; i++) {
      const res = await callWorker(
        env,
        '/api/admin/settings/test-email',
        postJson({ to: `x${i}@example.com` }, { headers })
      )
      statuses.push(res.status)
    }
    // No provider configured in tests, so allowed sends fail with 500; the 6th is rate-limited
    expect(statuses).toEqual([500, 500, 500, 500, 500, 429])
  })

  it('answers 400 to a missing or malformed body', async () => {
    const env = fakeEnv()
    const headers = await bearer(env, 'admin-1', 'admin')
    const bad = await callWorker(env, '/api/admin/settings/test-email', { method: 'POST', headers, body: 'nope' })
    expect(bad.status).toBe(400)
    const crlf = await callWorker(
      env,
      '/api/admin/settings/test-email',
      postJson({ to: 'a@example.com\r\nBcc: b@example.com' }, { headers })
    )
    expect(crlf.status).toBe(400)
  })
})

describe('PATCH /api/admin/settings', () => {
  const patch = (body: unknown, headers: Record<string, string>) => postJson(body, { method: 'PATCH', headers })

  it('rejects a malformed sender address without saving anything', async () => {
    const { db, calls } = fakeD1()
    const env = fakeEnv({ DB: db })
    const headers = await bearer(env, 'admin-1', 'admin')
    const smtp = JSON.stringify({ host: 'smtp.example.com', from: 'noreply@example.com\r\nRCPT TO:<x@example.com>' })
    const res = await callWorker(env, '/api/admin/settings', patch({ app_name: 'Renamed', smtp_config: smtp }, headers))
    expect(res.status).toBe(400)
    expect(calls.some((c) => c.sql.startsWith('INSERT INTO settings'))).toBe(false)
  })

  it('accepts a valid or empty sender address', async () => {
    const { db, calls } = fakeD1()
    const env = fakeEnv({ DB: db })
    const headers = await bearer(env, 'admin-1', 'admin')
    for (const from of ['noreply@example.com', '']) {
      const res = await callWorker(
        env,
        '/api/admin/settings',
        patch({ resend_config: JSON.stringify({ api_key: 're_x', from }) }, headers)
      )
      expect(res.status).toBe(200)
    }
    expect(calls.filter((c) => c.sql.startsWith('INSERT INTO settings'))).toHaveLength(2)
  })
})

describe('PATCH /api/admin/settings email secrets', () => {
  const patch = (body: unknown, headers: Record<string, string>) => postJson(body, { method: 'PATCH', headers })
  const stored = JSON.stringify({ host: 'smtp.example.com', username: 'u', password: 'old-password' })

  async function save(password: unknown) {
    const { db, calls } = fakeD1((sql) =>
      sql.startsWith('SELECT key, value FROM settings') ? [{ key: 'smtp_config', value: stored }] : null
    )
    const env = fakeEnv({ DB: db })
    const config: Record<string, unknown> = { host: 'smtp2.example.com', username: 'u' }
    if (password !== undefined) config.password = password
    const res = await callWorker(
      env,
      '/api/admin/settings',
      patch({ smtp_config: JSON.stringify(config) }, await bearer(env, 'admin-1', 'admin'))
    )
    const write = calls.find((c) => c.sql.startsWith('INSERT INTO settings'))
    return { status: res.status, saved: write ? JSON.parse(write.args[1] as string) : null }
  }

  it('keeps the stored secret when it is omitted or sent back masked', async () => {
    for (const password of [undefined, '••••••']) {
      const { saved } = await save(password)
      expect(saved.host).toBe('smtp2.example.com')
      expect(saved.password).toMatch(/^enc:/)
      expect(saved.password).not.toContain('•')
    }
  })

  it('clears the stored secret when an empty string is sent', async () => {
    const { status, saved } = await save('')
    expect(status).toBe(200)
    expect(saved.password).toBe('')
  })

  it('stores a new secret encrypted', async () => {
    const { saved } = await save('new-password')
    expect(saved.password).toMatch(/^enc:/)
  })

  it('ignores a config whose secret is not a string', async () => {
    const { status, saved } = await save(42)
    expect(status).toBe(200)
    expect(saved).toBeNull()
  })
})

describe('PATCH /api/admin/settings resend api key', () => {
  it('clears the stored key on an explicit empty string and keeps it when omitted', async () => {
    const stored = JSON.stringify({ api_key: 're_old', from: 'noreply@example.com' })
    for (const [config, expected] of [
      [{ from: 'noreply@example.com', api_key: '' }, ''],
      [{ from: 'noreply@example.com' }, /^enc:/],
    ] as const) {
      const { db, calls } = fakeD1((sql) =>
        sql.startsWith('SELECT key, value FROM settings') ? [{ key: 'resend_config', value: stored }] : null
      )
      const env = fakeEnv({ DB: db })
      const res = await callWorker(
        env,
        '/api/admin/settings',
        postJson(
          { resend_config: JSON.stringify(config) },
          { method: 'PATCH', headers: await bearer(env, 'admin-1', 'admin') }
        )
      )
      expect(res.status).toBe(200)
      const write = calls.find((c) => c.sql.startsWith('INSERT INTO settings'))!
      const saved = JSON.parse(write.args[1] as string)
      if (typeof expected === 'string') expect(saved.api_key).toBe(expected)
      else expect(saved.api_key).toMatch(expected)
    }
  })
})

describe('PATCH /api/admin/settings setup_page_enabled', () => {
  const patch = (body: unknown, headers: Record<string, string>) => postJson(body, { method: 'PATCH', headers })

  it('saves only the valid 0 / 1 values', async () => {
    const { db, calls } = fakeD1()
    const env = fakeEnv({ DB: db })
    const headers = await bearer(env, 'admin-1', 'admin')
    for (const value of ['0', '1', 'true', 'yes', '2']) {
      await callWorker(env, '/api/admin/settings', patch({ setup_page_enabled: value }, headers))
    }
    const writes = calls.filter((c) => c.sql.startsWith('INSERT INTO settings') && c.args[0] === 'setup_page_enabled')
    expect(writes.map((w) => w.args[1])).toEqual(['0', '1'])
  })

  it('returns the default 1 via GET when the row is absent', async () => {
    const { db } = fakeD1(() => null)
    const env = fakeEnv({ DB: db })
    const res = await callWorker(env, '/api/admin/settings', { headers: await bearer(env, 'admin-1', 'admin') })
    expect(res.status).toBe(200)
    expect(((await res.json()) as { setup_page_enabled?: string }).setup_page_enabled).toBe('1')
  })
})

describe('database registry over the D1 HTTP API', () => {
  const APP_DB = '11111111-1111-4111-8111-111111111111'
  const DB_1 = '22222222-2222-4222-8222-222222222222'
  const DB_2 = '33333333-3333-4333-8333-333333333333'

  const cfList = (rows: Array<{ uuid: string; name: string }>) =>
    new Response(
      JSON.stringify({
        success: true,
        result: rows.map((r) => ({ ...r, created_at: 'x' })),
        result_info: { page: 1, per_page: 100, total_count: rows.length },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    )

  const cfEnv = (handler?: Parameters<typeof fakeD1>[0]) =>
    fakeEnv({
      DB: fakeD1(handler).db,
      CF_ACCOUNT_ID: 'acct',
      CF_D1_API_TOKEN: 'tok',
      ZETA_APP_DB_ID: APP_DB,
    })

  it('lists account databases, excluding the app DB and marking added', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        cfList([
          { uuid: APP_DB, name: 'zeta' },
          { uuid: DB_1, name: 'analytics' },
          { uuid: DB_2, name: 'logs' },
        ])
      )
    )
    const { db } = fakeD1((sql) =>
      sql.includes('WHERE cf_database_id IS NOT NULL') ? [{ id: 'r1', cf_database_id: DB_1 }] : null
    )
    const env = fakeEnv({ DB: db, CF_ACCOUNT_ID: 'acct', CF_D1_API_TOKEN: 'tok', ZETA_APP_DB_ID: APP_DB })
    const res = await callWorker(env, '/api/admin/d1/databases', { headers: await bearer(env, 'a1', 'admin') })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { results: Array<Record<string, unknown>> }
    expect(body.results).toEqual([
      { uuid: DB_1, name: 'analytics', created_at: 'x', added: true, database_id: 'r1', is_app_db: false },
      { uuid: DB_2, name: 'logs', created_at: 'x', added: false, database_id: null, is_app_db: false },
    ])
  })

  it('registers a database picked from the account list', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        cfList([
          { uuid: APP_DB, name: 'zeta' },
          { uuid: DB_1, name: 'analytics' },
        ])
      )
    )
    const { db, calls } = fakeD1()
    const env = fakeEnv({ DB: db, CF_ACCOUNT_ID: 'acct', CF_D1_API_TOKEN: 'tok', ZETA_APP_DB_ID: APP_DB })
    const res = await callWorker(
      env,
      '/api/admin/databases',
      postJson({ cf_database_id: DB_1 }, { headers: await bearer(env, 'a1', 'admin') })
    )
    expect(res.status).toBe(201)
    const insert = calls.find((c) => c.sql.startsWith('INSERT INTO d1_databases'))
    expect(insert).toBeTruthy()
    expect(insert!.args[1]).toBe('analytics') // default display name from the CF list
    expect(insert!.args[3]).toBe(`cf:${DB_1}`) // synthetic binding_name
    expect(insert!.args[4]).toBe(DB_1) // cf_database_id
  })

  it('refuses to register the application database', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        cfList([
          { uuid: APP_DB, name: 'zeta' },
          { uuid: DB_1, name: 'analytics' },
        ])
      )
    )
    const { db, calls } = fakeD1()
    const env = fakeEnv({ DB: db, CF_ACCOUNT_ID: 'acct', CF_D1_API_TOKEN: 'tok', ZETA_APP_DB_ID: APP_DB })
    const res = await callWorker(
      env,
      '/api/admin/databases',
      postJson({ cf_database_id: APP_DB }, { headers: await bearer(env, 'a1', 'admin') })
    )
    expect(res.status).toBe(400)
    expect(calls.some((c) => c.sql.startsWith('INSERT INTO d1_databases'))).toBe(false)
  })

  it('rejects a database id not present in the account', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        cfList([
          { uuid: APP_DB, name: 'zeta' },
          { uuid: DB_1, name: 'analytics' },
        ])
      )
    )
    const env = cfEnv()
    const res = await callWorker(
      env,
      '/api/admin/databases',
      postJson({ cf_database_id: DB_2 }, { headers: await bearer(env, 'a1', 'admin') })
    )
    expect(res.status).toBe(404)
  })

  it('re-links a legacy database to a cf_database_id', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        cfList([
          { uuid: APP_DB, name: 'zeta' },
          { uuid: DB_1, name: 'analytics' },
        ])
      )
    )
    const { db, calls } = fakeD1()
    const env = fakeEnv({ DB: db, CF_ACCOUNT_ID: 'acct', CF_D1_API_TOKEN: 'tok', ZETA_APP_DB_ID: APP_DB })
    const res = await callWorker(
      env,
      '/api/admin/databases/r1',
      postJson({ cf_database_id: DB_1 }, { method: 'PATCH', headers: await bearer(env, 'a1', 'admin') })
    )
    expect(res.status).toBe(200)
    const update = calls.find((c) => c.sql.startsWith('UPDATE d1_databases'))
    expect(update).toBeTruthy()
    expect(update!.args[0]).toBe(DB_1)
  })

  it('returns a clear error when the API token is not configured', async () => {
    const env = fakeEnv({ DB: fakeD1().db, CF_ACCOUNT_ID: 'acct', CF_D1_API_TOKEN: '', ZETA_APP_DB_ID: APP_DB })
    const res = await callWorker(env, '/api/admin/d1/databases', { headers: await bearer(env, 'a1', 'admin') })
    expect(res.status).toBe(500)
    expect(((await res.json()) as { error: string }).error).toContain('CF_D1_API_TOKEN')
  })

  it('rejects registering a database that is already registered', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        cfList([
          { uuid: APP_DB, name: 'zeta' },
          { uuid: DB_1, name: 'analytics' },
        ])
      )
    )
    const { db } = fakeD1((sql) => (sql.includes('WHERE cf_database_id = ?1') ? { id: 'existing' } : null))
    const env = fakeEnv({ DB: db, CF_ACCOUNT_ID: 'acct', CF_D1_API_TOKEN: 'tok', ZETA_APP_DB_ID: APP_DB })
    const res = await callWorker(
      env,
      '/api/admin/databases',
      postJson({ cf_database_id: DB_1 }, { headers: await bearer(env, 'a1', 'admin') })
    )
    expect(res.status).toBe(409)
  })

  it('rejects re-linking to a database already registered elsewhere', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        cfList([
          { uuid: APP_DB, name: 'zeta' },
          { uuid: DB_1, name: 'analytics' },
        ])
      )
    )
    const { db } = fakeD1((sql) => (sql.includes('WHERE cf_database_id = ?1 AND id != ?2') ? { id: 'other' } : null))
    const env = fakeEnv({ DB: db, CF_ACCOUNT_ID: 'acct', CF_D1_API_TOKEN: 'tok', ZETA_APP_DB_ID: APP_DB })
    const res = await callWorker(
      env,
      '/api/admin/databases/r1',
      postJson({ cf_database_id: DB_1 }, { method: 'PATCH', headers: await bearer(env, 'a1', 'admin') })
    )
    expect(res.status).toBe(409)
  })

  it('fails closed when ZETA_APP_DB_ID is not configured', async () => {
    const env = fakeEnv({ DB: fakeD1().db, CF_ACCOUNT_ID: 'acct', CF_D1_API_TOKEN: 'tok', ZETA_APP_DB_ID: '' })
    const res = await callWorker(
      env,
      '/api/admin/databases',
      postJson({ cf_database_id: DB_1 }, { headers: await bearer(env, 'a1', 'admin') })
    )
    expect(res.status).toBe(500)
    expect(((await res.json()) as { error: string }).error).toContain('ZETA_APP_DB_ID')
  })
})

describe('application database as a query target (ALLOW_APP_DB_AS_TARGET)', () => {
  const APP_DB = '11111111-1111-4111-8111-111111111111'
  const DB_1 = '22222222-2222-4222-8222-222222222222'

  const cfList = (rows: Array<{ uuid: string; name: string }>) =>
    new Response(
      JSON.stringify({
        success: true,
        result: rows.map((r) => ({ ...r, created_at: 'x' })),
        result_info: { page: 1, per_page: 100, total_count: rows.length },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    )

  const switchOnEnv = (handler?: Parameters<typeof fakeD1>[0]) =>
    fakeEnv({
      DB: fakeD1(handler).db,
      CF_ACCOUNT_ID: 'acct',
      CF_D1_API_TOKEN: 'tok',
      ZETA_APP_DB_ID: APP_DB,
      ALLOW_APP_DB_AS_TARGET: 'true',
    })

  it('lists the application database with is_app_db when the switch is on', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        cfList([
          { uuid: APP_DB, name: 'zeta' },
          { uuid: DB_1, name: 'analytics' },
        ])
      )
    )
    const { db } = fakeD1((sql) =>
      sql.includes('WHERE cf_database_id IS NOT NULL') ? [{ id: 'r1', cf_database_id: DB_1 }] : null
    )
    const env = fakeEnv({
      DB: db,
      CF_ACCOUNT_ID: 'acct',
      CF_D1_API_TOKEN: 'tok',
      ZETA_APP_DB_ID: APP_DB,
      ALLOW_APP_DB_AS_TARGET: 'true',
    })
    const res = await callWorker(env, '/api/admin/d1/databases', { headers: await bearer(env, 'a1', 'admin') })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { results: Array<Record<string, unknown>> }
    expect(body.results).toEqual([
      { uuid: APP_DB, name: 'zeta', created_at: 'x', added: false, database_id: null, is_app_db: true },
      { uuid: DB_1, name: 'analytics', created_at: 'x', added: true, database_id: 'r1', is_app_db: false },
    ])
  })

  it('registers the application database when the switch is on', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        cfList([
          { uuid: APP_DB, name: 'zeta' },
          { uuid: DB_1, name: 'analytics' },
        ])
      )
    )
    const { db, calls } = fakeD1()
    const env = fakeEnv({
      DB: db,
      CF_ACCOUNT_ID: 'acct',
      CF_D1_API_TOKEN: 'tok',
      ZETA_APP_DB_ID: APP_DB,
      ALLOW_APP_DB_AS_TARGET: 'true',
    })
    const res = await callWorker(
      env,
      '/api/admin/databases',
      postJson({ cf_database_id: APP_DB }, { headers: await bearer(env, 'a1', 'admin') })
    )
    expect(res.status).toBe(201)
    const insert = calls.find((c) => c.sql.startsWith('INSERT INTO d1_databases'))
    expect(insert).toBeTruthy()
    expect(insert!.args[1]).toBe('zeta')
    expect(insert!.args[4]).toBe(APP_DB)
  })

  it('re-links a legacy database to the application database when the switch is on', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        cfList([
          { uuid: APP_DB, name: 'zeta' },
          { uuid: DB_1, name: 'analytics' },
        ])
      )
    )
    const { db, calls } = fakeD1()
    const env = fakeEnv({
      DB: db,
      CF_ACCOUNT_ID: 'acct',
      CF_D1_API_TOKEN: 'tok',
      ZETA_APP_DB_ID: APP_DB,
      ALLOW_APP_DB_AS_TARGET: 'true',
    })
    const res = await callWorker(
      env,
      '/api/admin/databases/r1',
      postJson({ cf_database_id: APP_DB }, { method: 'PATCH', headers: await bearer(env, 'a1', 'admin') })
    )
    expect(res.status).toBe(200)
    const update = calls.find((c) => c.sql.startsWith('UPDATE d1_databases'))
    expect(update).toBeTruthy()
    expect(update!.args[0]).toBe(APP_DB)
  })

  it('keeps refusing the application database for any other switch value', async () => {
    for (const value of ['false', 'yes', '1', '']) {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          cfList([
            { uuid: APP_DB, name: 'zeta' },
            { uuid: DB_1, name: 'analytics' },
          ])
        )
      )
      const { db, calls } = fakeD1()
      const env = fakeEnv({
        DB: db,
        CF_ACCOUNT_ID: 'acct',
        CF_D1_API_TOKEN: 'tok',
        ZETA_APP_DB_ID: APP_DB,
        ALLOW_APP_DB_AS_TARGET: value,
      })
      const res = await callWorker(
        env,
        '/api/admin/databases',
        postJson({ cf_database_id: APP_DB }, { headers: await bearer(env, 'a1', 'admin') })
      )
      expect(res.status).toBe(400)
      expect(calls.some((c) => c.sql.startsWith('INSERT INTO d1_databases'))).toBe(false)
    }
    vi.unstubAllGlobals()
  })

  it('annotates registry rows with is_app_db', async () => {
    const { db } = fakeD1((sql) =>
      sql.startsWith('SELECT * FROM d1_databases')
        ? [
            {
              id: 'r1',
              name: 'app',
              description: null,
              binding_name: `cf:${APP_DB}`,
              cf_database_id: APP_DB,
              is_active: 1,
              created_at: 0,
              created_by: null,
            },
            {
              id: 'r2',
              name: 'logs',
              description: null,
              binding_name: `cf:${DB_1}`,
              cf_database_id: DB_1,
              is_active: 1,
              created_at: 0,
              created_by: null,
            },
          ]
        : null
    )
    const env = fakeEnv({ DB: db, ZETA_APP_DB_ID: APP_DB })
    const res = await callWorker(env, '/api/admin/databases', { headers: await bearer(env, 'a1', 'admin') })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { results: Array<{ id: string; is_app_db: boolean }> }
    expect(body.results.find((r) => r.id === 'r1')!.is_app_db).toBe(true)
    expect(body.results.find((r) => r.id === 'r2')!.is_app_db).toBe(false)
  })

  it('refuses to grant write_drop on an application-database registry row', async () => {
    const { db, calls } = fakeD1((sql) =>
      sql.includes('SELECT cf_database_id FROM d1_databases') ? { cf_database_id: APP_DB } : null
    )
    const env = switchOnEnv()
    env.DB = db
    const res = await callWorker(
      env,
      '/api/admin/databases/r1/permissions/u1',
      postJson({ permission: 'write_drop' }, { method: 'PUT', headers: await bearer(env, 'a1', 'admin') })
    )
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toContain('write')
    expect(calls.some((c) => c.sql.startsWith('INSERT INTO user_database_permissions'))).toBe(false)
  })

  it('still grants write and read on an application-database registry row', async () => {
    for (const permission of ['read', 'write']) {
      const { db, calls } = fakeD1((sql) =>
        sql.includes('SELECT cf_database_id FROM d1_databases') ? { cf_database_id: APP_DB } : null
      )
      const env = switchOnEnv()
      env.DB = db
      const res = await callWorker(
        env,
        '/api/admin/databases/r1/permissions/u1',
        postJson({ permission }, { method: 'PUT', headers: await bearer(env, 'a1', 'admin') })
      )
      expect(res.status).toBe(200)
      expect(calls.some((c) => c.sql.startsWith('INSERT INTO user_database_permissions'))).toBe(true)
    }
  })
})

describe('POST /api/admin/setup', () => {
  const upToDate = [
    { name: 'id', notnull: 0 },
    { name: 'user_id', notnull: 0 },
    { name: 'database_id', notnull: 0 },
    { name: 'notebook_run_limit', notnull: 0 },
    { name: 'last_run_seq', notnull: 1 },
    { name: 'seq', notnull: 0 },
    { name: 'cf_database_id', notnull: 0 },
  ]

  it('runs the setup routine for an admin, without requiring SETUP_SECRET', async () => {
    const { db, calls } = fakeD1((sql) => {
      if (!sql.startsWith('PRAGMA table_info')) return null
      return sql.includes('d1_databases')
        ? [
            { name: 'id', notnull: 0 },
            { name: 'binding_name', notnull: 1 },
          ]
        : upToDate
    })
    const env = fakeEnv({ DB: db, SETUP_SECRET: '' })
    const res = await callWorker(env, '/api/admin/setup', {
      method: 'POST',
      headers: await bearer(env, 'admin-1', 'admin'),
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, upgraded: [expect.stringContaining('cf_database_id')] })
    expect(calls.some((c) => c.sql === 'ALTER TABLE d1_databases ADD COLUMN cf_database_id TEXT')).toBe(true)
  })

  it('rejects a non-admin user with 403', async () => {
    const env = fakeEnv()
    const res = await callWorker(env, '/api/admin/setup', {
      method: 'POST',
      headers: await bearer(env, 'member-1', 'member'),
    })
    expect(res.status).toBe(403)
  })

  it('rejects an unauthenticated request with 401', async () => {
    const res = await callWorker(fakeEnv(), '/api/admin/setup', { method: 'POST' })
    expect(res.status).toBe(401)
  })

  it('actually applies the upgrade: adds cf_database_id to an older database', async () => {
    const { db, sqlite } = sqliteD1()
    const env = fakeEnv({ DB: db })
    // Initialise a full current schema through the keyed endpoint, then rewind d1_databases to a
    // pre-cf_database_id state to simulate a database created by an older version.
    expect((await callWorker(env, '/api/setup', postJson({ secret: 'test-setup-secret' }))).status).toBe(200)
    sqlite.exec('ALTER TABLE d1_databases DROP COLUMN cf_database_id')

    const res = await callWorker(env, '/api/admin/setup', {
      method: 'POST',
      headers: await bearer(env, 'admin-1', 'admin'),
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, upgraded: [expect.stringContaining('cf_database_id')] })

    const cols = sqlite.prepare('PRAGMA table_info(d1_databases)').all() as Array<{ name: string }>
    expect(cols.some((c) => c.name === 'cf_database_id')).toBe(true)
  })
})
