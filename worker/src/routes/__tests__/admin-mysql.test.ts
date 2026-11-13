import { afterEach, describe, expect, it, vi } from 'vitest'
import { getMigrations } from '../../lib/migrations'
import { openSecret, sealSecret } from '../../lib/secrets'
import type { Env } from '../../types'
import { bearer, callWorker, fakeEnv, postJson } from './fakes'
import { sqliteD1 } from './sqlite-d1'

// Registering MySQL targets (TiDB Cloud Starter) in the admin panel: the connection is proven
// before anything is stored, only TiDB Cloud hosts are accepted, and the sealed payload never comes
// back out.

const my = vi.hoisted(() => ({
  queue: [] as Array<{ kind: 'ok' | 'fail'; version?: string; message?: string }>,
  calls: [] as string[],
}))

const pg = vi.hoisted(() => ({
  calls: [] as string[],
}))

vi.mock('../../lib/mysql-executor', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/mysql-executor')>()
  return {
    ...actual,
    testMySqlConnection: async (url: string) => {
      my.calls.push(url)
      const next = my.queue.shift()
      if (!next || next.kind === 'ok') return { server_version: next?.version ?? '8.0.11-TiDB-v8.5.3' }
      throw new actual.MySqlQueryError(next.message ?? 'Connection failed.', 'auth')
    },
  }
})

vi.mock('../../lib/pg-executor', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/pg-executor')>()
  return {
    ...actual,
    testPostgresConnection: async (url: string) => {
      pg.calls.push(url)
      return { server_version: '18.6' }
    },
  }
})

const PASSWORD = 'pw0rd'
const HOST = 'gateway01.us-east-1.prod.aws.tidbcloud.com'
const RAW_URL = `mysql://3Kx9aBcD.root:${PASSWORD}@${HOST}/zeta?ssl-mode=VERIFY_IDENTITY&charset=utf8mb4`
const NORMALIZED_URL = `mysql://3Kx9aBcD.root:${PASSWORD}@${HOST}:4000/zeta`

afterEach(() => {
  my.queue.length = 0
  my.calls.length = 0
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

describe('POST /api/admin/databases/test-connection (kind=mysql)', () => {
  it('normalises the pasted URL, proves the connection and reports the engine and version', async () => {
    const e = env()
    my.queue.push({ kind: 'ok', version: '8.0.11-TiDB-v8.5.3' })
    const res = await callWorker(
      e,
      '/api/admin/databases/test-connection',
      postJson({ connection_url: RAW_URL, kind: 'mysql' }, { headers: await adminHeaders(e) })
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; kind: string; server_version: string; latency_ms: number }
    expect(body).toMatchObject({ ok: true, kind: 'mysql', server_version: '8.0.11-TiDB-v8.5.3' })
    expect(typeof body.latency_ms).toBe('number')
    // Parameters were dropped and the port pinned before the driver ever saw the URL
    expect(my.calls).toEqual([NORMALIZED_URL])
  })

  it('keeps the postgres default when no kind is sent', async () => {
    const e = env()
    const res = await callWorker(
      e,
      '/api/admin/databases/test-connection',
      postJson({ connection_url: 'postgres://u:p@ep-x.example.neon.tech/neondb' }, { headers: await adminHeaders(e) })
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, kind: 'postgres', server_version: '18.6' })
    expect(my.calls).toEqual([])
  })

  it('refuses a host that is not TiDB Cloud without calling the driver', async () => {
    const e = env()
    for (const connection_url of [
      `mysql://u:${PASSWORD}@db.example.com:3306/zeta`,
      `mysql://u:${PASSWORD}@localhost/zeta`,
      'mysql://u:p@10.0.0.5/zeta',
    ]) {
      const res = await callWorker(
        e,
        '/api/admin/databases/test-connection',
        postJson({ connection_url, kind: 'mysql' }, { headers: await adminHeaders(e) })
      )
      expect(res.status, connection_url).toBe(400)
      expect(((await res.json()) as { error: string }).error).toContain('TiDB Cloud Starter')
    }
    expect(my.calls).toEqual([])
  })

  it('rejects an unknown kind', async () => {
    const e = env()
    const res = await callWorker(
      e,
      '/api/admin/databases/test-connection',
      postJson({ connection_url: RAW_URL, kind: 'oracle' }, { headers: await adminHeaders(e) })
    )
    expect(res.status).toBe(400)
    expect(my.calls).toEqual([])
  })
})

describe('POST /api/admin/databases (kind=mysql)', () => {
  it('stores the target only after a successful connection, with a sealed payload', async () => {
    const e = env()
    my.queue.push({ kind: 'ok' })
    const res = await callWorker(
      e,
      '/api/admin/databases',
      postJson({ kind: 'mysql', connection_url: RAW_URL }, { headers: await adminHeaders(e) })
    )
    expect(res.status).toBe(201)
    const { id } = (await res.json()) as { id: string }

    const rows = await listRows(e)
    expect(rows).toHaveLength(1)
    const row = rows[0]!
    expect(row).toMatchObject({
      id,
      name: 'zeta', // default display name from the connection string's database
      kind: 'mysql',
      cf_database_id: null,
      binding_name: `my:${id}`,
      is_active: 1,
    })
    const sealed = row.connection_secret as string
    expect(sealed.startsWith('enc:v1:')).toBe(true)
    expect(sealed).not.toContain(PASSWORD)
    expect(JSON.parse(await openSecret(e, sealed))).toEqual({ url: NORMALIZED_URL })
    expect(my.calls).toEqual([NORMALIZED_URL])
  })

  it('does not store a target whose connection test failed', async () => {
    const e = env()
    my.queue.push({ kind: 'fail', message: 'Authentication failed: Access denied' })
    const res = await callWorker(
      e,
      '/api/admin/databases',
      postJson({ kind: 'mysql', name: 'tidb', connection_url: RAW_URL }, { headers: await adminHeaders(e) })
    )
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toContain('Authentication failed')
    expect(await listRows(e)).toEqual([])
  })

  it('does not store a target hosted outside TiDB Cloud', async () => {
    const e = env()
    const res = await callWorker(
      e,
      '/api/admin/databases',
      postJson(
        { kind: 'mysql', connection_url: `mysql://u:${PASSWORD}@db.example.com/zeta` },
        { headers: await adminHeaders(e) }
      )
    )
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toContain('TiDB Cloud Starter')
    expect(await listRows(e)).toEqual([])
    expect(my.calls).toEqual([])
  })

  it('requires a connection string', async () => {
    const e = env()
    const res = await callWorker(
      e,
      '/api/admin/databases',
      postJson({ kind: 'mysql' }, { headers: await adminHeaders(e) })
    )
    expect(res.status).toBe(400)
    expect(my.calls).toEqual([])
  })

  it('stores the provider label the registration names, trimmed', async () => {
    const e = env()
    my.queue.push({ kind: 'ok' })
    const res = await callWorker(
      e,
      '/api/admin/databases',
      postJson(
        { kind: 'mysql', connection_url: RAW_URL, provider: '  PlanetScale  ' },
        { headers: await adminHeaders(e) }
      )
    )
    expect(res.status).toBe(201)
    expect((await listRows(e))[0]!.provider).toBe('PlanetScale')

    // Read back through the list: the effective label and the stored text it came from
    const list = (await (await callWorker(e, '/api/admin/databases', { headers: await adminHeaders(e) })).json()) as {
      results: Array<Record<string, unknown>>
    }
    expect(list.results[0]).toMatchObject({ provider: 'PlanetScale', provider_custom: 'PlanetScale' })
  })

  it('refuses a provider longer than 40 characters before testing the connection', async () => {
    const e = env()
    const res = await callWorker(
      e,
      '/api/admin/databases',
      postJson({ kind: 'mysql', connection_url: RAW_URL, provider: 'p'.repeat(41) }, { headers: await adminHeaders(e) })
    )
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toBe('provider must be 40 characters or fewer')
    expect(await listRows(e)).toEqual([])
    expect(my.calls).toEqual([])
  })
})

describe('GET /api/admin/databases', () => {
  it('never returns the sealed connection for a mysql row', async () => {
    const e = env()
    my.queue.push({ kind: 'ok' })
    await callWorker(
      e,
      '/api/admin/databases',
      postJson({ kind: 'mysql', connection_url: RAW_URL }, { headers: await adminHeaders(e) })
    )
    const res = await callWorker(e, '/api/admin/databases', { headers: await adminHeaders(e) })
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).not.toContain('connection_secret')
    expect(text).not.toContain('enc:v1:')
    expect(text).not.toContain(PASSWORD)
    const body = JSON.parse(text) as { results: Array<Record<string, unknown>> }
    expect(body.results[0]).toMatchObject({ kind: 'mysql', has_connection: true, is_app_db: false })
  })
})

describe('PATCH /api/admin/databases/:id (kind=mysql)', () => {
  async function seed(e: Env): Promise<string> {
    const sealed = await sealSecret(e, JSON.stringify({ url: NORMALIZED_URL }))
    await e.DB.prepare(
      `INSERT INTO d1_databases (id, name, binding_name, cf_database_id, kind, connection_secret, is_active, created_at)
       VALUES ('my1', 'n', 'my:my1', NULL, 'mysql', ?1, 1, 0)`
    )
      .bind(sealed)
      .run()
    return 'my1'
  }

  it('re-tests a new connection string before replacing the stored one', async () => {
    const e = env()
    const id = await seed(e)
    const replacement = `mysql://other.root:${PASSWORD}@${HOST}:4000/other`
    my.queue.push({ kind: 'ok' })
    const res = await callWorker(e, `/api/admin/databases/${id}`, {
      ...postJson({ connection_url: replacement }, { headers: await adminHeaders(e) }),
      method: 'PATCH',
    })
    expect(res.status).toBe(200)
    expect(my.calls).toEqual([replacement])
    const sealed = (await listRows(e))[0]!.connection_secret as string
    expect(JSON.parse(await openSecret(e, sealed))).toEqual({ url: replacement })
  })

  it('keeps the stored connection when the new one fails the test', async () => {
    const e = env()
    const id = await seed(e)
    const before = (await listRows(e))[0]!.connection_secret
    my.queue.push({ kind: 'fail', message: 'Connection timed out' })
    const res = await callWorker(e, `/api/admin/databases/${id}`, {
      ...postJson({ connection_url: `mysql://u:${PASSWORD}@${HOST}/db` }, { headers: await adminHeaders(e) }),
      method: 'PATCH',
    })
    expect(res.status).toBe(400)
    expect((await listRows(e))[0]!.connection_secret).toBe(before)
  })

  it('refuses a Cloudflare link on a mysql row', async () => {
    const e = env()
    const id = await seed(e)
    const res = await callWorker(e, `/api/admin/databases/${id}`, {
      ...postJson({ cf_database_id: '22222222-2222-4222-8222-222222222222' }, { headers: await adminHeaders(e) }),
      method: 'PATCH',
    })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toContain('not linked to a Cloudflare database')
  })

  it('edits the provider, answers with the stored row and never echoes the connection', async () => {
    const e = env()
    const id = await seed(e)
    const res = await callWorker(e, `/api/admin/databases/${id}`, {
      ...postJson({ name: 'warehouse', provider: 'Aiven' }, { headers: await adminHeaders(e) }),
      method: 'PATCH',
    })
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).not.toContain('enc:v1:')
    expect(text).not.toContain(PASSWORD)
    expect(text).not.toContain('connection_secret')
    const body = JSON.parse(text) as { message: string; database: Record<string, unknown> }
    expect(body.message).toBe('Updated')
    expect(body.database).toMatchObject({
      id,
      name: 'warehouse',
      kind: 'mysql',
      provider: 'Aiven',
      provider_custom: 'Aiven',
      has_connection: true,
    })

    // The write reached the registry, and a later list agrees with the response
    expect((await listRows(e))[0]!.provider).toBe('Aiven')
    const list = (await (await callWorker(e, '/api/admin/databases', { headers: await adminHeaders(e) })).json()) as {
      results: Array<Record<string, unknown>>
    }
    expect(list.results[0]).toMatchObject({ provider: 'Aiven', provider_custom: 'Aiven' })

    // Clearing it puts the engine's own provider back
    const cleared = await callWorker(e, `/api/admin/databases/${id}`, {
      ...postJson({ provider: '' }, { headers: await adminHeaders(e) }),
      method: 'PATCH',
    })
    expect(cleared.status).toBe(200)
    const clearedBody = (await cleared.json()) as { database: Record<string, unknown> }
    expect(clearedBody.database).toMatchObject({ provider: 'TiDB', provider_custom: null })
    expect((await listRows(e))[0]!.provider).toBeNull()
  })

  it('refuses an over-long provider on edit and keeps the stored one', async () => {
    const e = env()
    const id = await seed(e)
    const res = await callWorker(e, `/api/admin/databases/${id}`, {
      ...postJson({ provider: 'p'.repeat(41) }, { headers: await adminHeaders(e) }),
      method: 'PATCH',
    })
    expect(res.status).toBe(400)
    expect((await listRows(e))[0]!.provider).toBeNull()
  })
})
