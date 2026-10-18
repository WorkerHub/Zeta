import { describe, it, expect, afterEach, vi } from 'vitest'
import { bearer, callWorker, fakeD1, fakeEnv, postJson } from './fakes'

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
      { uuid: DB_1, name: 'analytics', created_at: 'x', added: true, database_id: 'r1' },
      { uuid: DB_2, name: 'logs', created_at: 'x', added: false, database_id: null },
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
