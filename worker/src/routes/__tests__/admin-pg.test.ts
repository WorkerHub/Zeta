import { afterEach, describe, expect, it, vi } from 'vitest'
import { getMigrations } from '../../lib/migrations'
import { openSecret, sealSecret } from '../../lib/secrets'
import type { Env } from '../../types'
import { bearer, callWorker, fakeEnv, postJson } from './fakes'
import { sqliteD1 } from './sqlite-d1'

// Registering PostgreSQL targets in the admin panel: the connection is proven before anything is
// stored, the sealed payload never comes back out, and the engine-specific edit rules hold.

const pg = vi.hoisted(() => ({
  queue: [] as Array<{ kind: 'ok' | 'fail'; version?: string; message?: string }>,
  calls: [] as string[],
}))

vi.mock('../../lib/pg-executor', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/pg-executor')>()
  return {
    ...actual,
    testPostgresConnection: async (url: string) => {
      pg.calls.push(url)
      const next = pg.queue.shift()
      if (!next || next.kind === 'ok') return { server_version: next?.version ?? '18.6' }
      throw new actual.PostgresQueryError(next.message ?? 'Connection failed.', 'auth')
    },
  }
})

const PASS = 'pw0rd'
const RAW_URL = `postgres://owner:${PASS}@ep-x-pooler.example.neon.tech/neondb?sslmode=require&channel_binding=require`
const NORMALIZED_URL = `postgres://owner:${PASS}@ep-x-pooler.example.neon.tech/neondb?sslmode=require`

afterEach(() => {
  pg.queue.length = 0
  pg.calls.length = 0
})

function env(): Env {
  const app = sqliteD1()
  for (const migration of getMigrations({ TABLE_PREFIX: '' })) app.sqlite.exec(migration.sql)
  app.sqlite.exec(
    `INSERT INTO users (id, email, name, role, created_at, updated_at)
       VALUES ('a1', 'admin@example.com', 'Admin', 'admin', 0, 0), ('u1', 'member@example.com', 'Member', 'member', 0, 0)`
  )
  return fakeEnv({ DB: app.db })
}

async function adminHeaders(env: Env) {
  return bearer(env, 'a1', 'admin')
}

async function listRows(env: Env) {
  const res = await env.DB.prepare(`SELECT * FROM d1_databases`).all<Record<string, unknown>>()
  return res.results
}

describe('POST /api/admin/databases/test-connection', () => {
  it('normalises the pasted URL, proves the connection and reports the server version', async () => {
    const e = env()
    pg.queue.push({ kind: 'ok', version: '18.6' })
    const res = await callWorker(
      e,
      '/api/admin/databases/test-connection',
      postJson({ connection_url: RAW_URL }, { headers: await adminHeaders(e) })
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; server_version: string; latency_ms: number }
    expect(body.ok).toBe(true)
    expect(body.server_version).toBe('18.6')
    expect(typeof body.latency_ms).toBe('number')
    // channel_binding was dropped before the driver ever saw the URL
    expect(pg.calls).toEqual([NORMALIZED_URL])
  })

  it('reports a rejected credential readably and saves nothing', async () => {
    const e = env()
    pg.queue.push({ kind: 'fail', message: 'Authentication failed: wrong credentials' })
    const res = await callWorker(
      e,
      '/api/admin/databases/test-connection',
      postJson({ connection_url: RAW_URL }, { headers: await adminHeaders(e) })
    )
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toContain('Authentication failed')
    expect(await listRows(e)).toEqual([])
  })

  it('rejects a malformed URL without calling the driver', async () => {
    const e = env()
    for (const connection_url of ['', 'mysql://u:p@h/db', 'not a url']) {
      const res = await callWorker(
        e,
        '/api/admin/databases/test-connection',
        postJson({ connection_url }, { headers: await adminHeaders(e) })
      )
      expect(res.status, connection_url).toBe(400)
    }
    expect(pg.calls).toEqual([])
  })

  it('is admin-only', async () => {
    const e = env()
    const res = await callWorker(
      e,
      '/api/admin/databases/test-connection',
      postJson({ connection_url: RAW_URL }, { headers: await bearer(e, 'u1') })
    )
    expect(res.status).toBe(403)
    expect(pg.calls).toEqual([])
  })
})

describe('POST /api/admin/databases (kind=postgres)', () => {
  it('stores the target only after a successful connection, with a sealed payload', async () => {
    const e = env()
    pg.queue.push({ kind: 'ok' })
    const res = await callWorker(
      e,
      '/api/admin/databases',
      postJson({ kind: 'postgres', connection_url: RAW_URL }, { headers: await adminHeaders(e) })
    )
    expect(res.status).toBe(201)
    const { id } = (await res.json()) as { id: string }

    const rows = await listRows(e)
    expect(rows).toHaveLength(1)
    const row = rows[0]!
    expect(row).toMatchObject({
      id,
      name: 'neondb', // default display name from the connection string
      kind: 'postgres',
      cf_database_id: null,
      binding_name: `pg:${id}`,
      is_active: 1,
    })
    const sealed = row.connection_secret as string
    expect(sealed.startsWith('enc:v1:')).toBe(true)
    expect(sealed).not.toContain(PASS)
    expect(JSON.parse(await openSecret(e, sealed))).toEqual({ url: NORMALIZED_URL })
    expect(pg.calls).toEqual([NORMALIZED_URL])
  })

  it('does not store a target whose connection test failed', async () => {
    const e = env()
    pg.queue.push({ kind: 'fail', message: 'The database does not exist' })
    const res = await callWorker(
      e,
      '/api/admin/databases',
      postJson({ kind: 'postgres', name: 'neon', connection_url: RAW_URL }, { headers: await adminHeaders(e) })
    )
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toContain('does not exist')
    expect(await listRows(e)).toEqual([])
  })

  it('refuses an unknown kind and a missing connection string', async () => {
    const e = env()
    const headers = await adminHeaders(e)
    const unknown = await callWorker(e, '/api/admin/databases', postJson({ kind: 'mysql' }, { headers }))
    expect(unknown.status).toBe(400)
    const missing = await callWorker(e, '/api/admin/databases', postJson({ kind: 'postgres' }, { headers }))
    expect(missing.status).toBe(400)
    expect(pg.calls).toEqual([])
  })
})

describe('GET /api/admin/databases', () => {
  it('never returns the sealed connection and flags rows that have one', async () => {
    const e = env()
    pg.queue.push({ kind: 'ok' })
    await callWorker(
      e,
      '/api/admin/databases',
      postJson({ kind: 'postgres', connection_url: RAW_URL }, { headers: await adminHeaders(e) })
    )
    const res = await callWorker(e, '/api/admin/databases', { headers: await adminHeaders(e) })
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).not.toContain('connection_secret')
    expect(text).not.toContain('enc:v1:')
    expect(text).not.toContain(PASS)
    const body = JSON.parse(text) as { results: Array<Record<string, unknown>> }
    expect(body.results[0]).toMatchObject({ kind: 'postgres', has_connection: true, is_app_db: false })
  })
})

describe('PATCH /api/admin/databases/:id', () => {
  async function seed(e: Env, kind: 'postgres' | 'sqlite'): Promise<string> {
    const id = kind === 'postgres' ? 'pg1' : 'db1'
    const sealed = await sealSecret(e, JSON.stringify({ url: NORMALIZED_URL }))
    await e.DB.prepare(
      `INSERT INTO d1_databases (id, name, binding_name, cf_database_id, kind, connection_secret, is_active, created_at)
       VALUES (?1, 'n', ?2, ?3, ?4, ?5, 1, 0)`
    )
      .bind(
        id,
        `${kind}:${id}`,
        kind === 'sqlite' ? '11111111-1111-4111-8111-111111111111' : null,
        kind,
        kind === 'postgres' ? sealed : null
      )
      .run()
    return id
  }

  it('re-tests a new connection string before replacing the stored one', async () => {
    const e = env()
    const id = await seed(e, 'postgres')
    const replacement = `postgres://owner:${PASS}@direct.example.neon.tech/neondb?sslmode=require`
    pg.queue.push({ kind: 'ok' })
    const res = await callWorker(e, `/api/admin/databases/${id}`, {
      ...postJson({ connection_url: replacement }, { headers: await adminHeaders(e) }),
      method: 'PATCH',
    })
    expect(res.status).toBe(200)
    expect(pg.calls).toEqual([replacement])
    const rows = await listRows(e)
    const sealed = rows[0]!.connection_secret as string
    expect(JSON.parse(await openSecret(e, sealed))).toEqual({ url: replacement })
  })

  it('keeps the stored connection when the new one fails the test', async () => {
    const e = env()
    const id = await seed(e, 'postgres')
    const before = (await listRows(e))[0]!.connection_secret
    pg.queue.push({ kind: 'fail', message: 'Connection timed out' })
    const res = await callWorker(e, `/api/admin/databases/${id}`, {
      ...postJson(
        { connection_url: `postgres://owner:${PASS}@dead.example.neon.tech/neondb` },
        { headers: await adminHeaders(e) }
      ),
      method: 'PATCH',
    })
    expect(res.status).toBe(400)
    expect((await listRows(e))[0]!.connection_secret).toBe(before)
  })

  it('keeps the two engines apart: no connection string on sqlite, no CF link on postgres', async () => {
    const e = env()
    const headers = await adminHeaders(e)
    const pgId = await seed(e, 'postgres')
    const sqliteId = await seed(e, 'sqlite')

    const pgWithCf = await callWorker(e, `/api/admin/databases/${pgId}`, {
      ...postJson({ cf_database_id: '22222222-2222-4222-8222-222222222222' }, { headers }),
      method: 'PATCH',
    })
    expect(pgWithCf.status).toBe(400)

    const sqliteWithUrl = await callWorker(e, `/api/admin/databases/${sqliteId}`, {
      ...postJson({ connection_url: RAW_URL }, { headers }),
      method: 'PATCH',
    })
    expect(sqliteWithUrl.status).toBe(400)
  })

  it('answers 404 for a row that does not exist', async () => {
    const e = env()
    const res = await callWorker(e, '/api/admin/databases/nope', {
      ...postJson({ name: 'x' }, { headers: await adminHeaders(e) }),
      method: 'PATCH',
    })
    expect(res.status).toBe(404)
  })
})
