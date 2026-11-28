import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getMigrations } from '../../lib/migrations'
import { sealSecret } from '../../lib/secrets'
import type { Env } from '../../types'
import { bearer, callWorker, fakeEnv } from './fakes'
import { sqliteD1 } from './sqlite-d1'

const UI_URL = 'https://spark-ui-4040.publish.example.dev'
const UI_TOKEN = 'spark-ui-platform-token-secret'

function env(): Env {
  const app = sqliteD1()
  for (const migration of getMigrations({ TABLE_PREFIX: '' })) app.sqlite.exec(migration.sql)
  app.sqlite.exec(
    `INSERT INTO users (id, email, name, role, created_at, updated_at)
       VALUES ('a1', 'admin@example.com', 'Admin', 'admin', 0, 0),
              ('u1', 'member@example.com', 'Member', 'member', 0, 0),
              ('u2', 'stranger@example.com', 'Stranger', 'member', 0, 0)`
  )
  return fakeEnv({ DB: app.db })
}

async function seedSparkDatabase(e: Env, opts: { id?: string; withUi?: boolean; kind?: string } = {}): Promise<string> {
  const id = opts.id ?? 'sp1'
  const kind = opts.kind ?? 'spark'
  const payload: Record<string, unknown> = {
    url: 'https://spark-8080.publish.example.dev',
    platform_token: 'p-token',
    app_token: 'a-token',
  }
  if (opts.withUi !== false) {
    payload.ui_url = UI_URL
    payload.ui_platform_token = UI_TOKEN
  }
  const sealed = await sealSecret(e, JSON.stringify(payload))
  await e.DB.prepare(
    `INSERT INTO d1_databases (id, name, binding_name, cf_database_id, kind, connection_secret, is_active, created_at)
     VALUES (?1, ?2, ?3, NULL, ?4, ?5, 1, 0)`
  )
    .bind(id, `db-${id}`, `spark:${id}`, kind, sealed)
    .run()
  return id
}

async function grantPermission(e: Env, userId: string, databaseId: string, permission = 'read'): Promise<void> {
  await e.DB.prepare(
    `INSERT INTO user_database_permissions (id, user_id, database_id, permission, granted_at)
     VALUES (?1, ?2, ?3, ?4, 0)`
  )
    .bind(`p-${userId}-${databaseId}`, userId, databaseId, permission)
    .run()
}

describe('/spark-ui access control', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    fetchMock = vi.fn()
    globalThis.fetch = fetchMock as unknown as typeof fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('blocks unauthenticated visits to /spark-ui/ with 401', async () => {
    const e = env()
    const res = await callWorker(e, '/spark-ui/')
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'Unauthorized' })
  })

  it('blocks unauthenticated visits to /spark-ui/?db=sp1 with 401', async () => {
    const e = env()
    await seedSparkDatabase(e, { id: 'sp1' })
    const res = await callWorker(e, '/spark-ui/?db=sp1')
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'Unauthorized' })
  })

  it('rejects /spark-ui/?db=missing with 404', async () => {
    const e = env()
    const headers = await bearer(e, 'a1', 'admin')
    const res = await callWorker(e, '/spark-ui/?db=nonexistent', { headers })
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'Database not found' })
  })

  it('rejects non-spark databases with 404', async () => {
    const e = env()
    await seedSparkDatabase(e, { id: 'pg1', kind: 'postgres' })
    const headers = await bearer(e, 'a1', 'admin')
    const res = await callWorker(e, '/spark-ui/?db=pg1', { headers })
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'Database is not a Spark database' })
  })

  it('rejects spark databases without UI configured with 404', async () => {
    const e = env()
    await seedSparkDatabase(e, { id: 'sp_no_ui', withUi: false })
    const headers = await bearer(e, 'a1', 'admin')
    const res = await callWorker(e, '/spark-ui/?db=sp_no_ui', { headers })
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'Spark UI not configured' })
  })

  it('rejects users without permission with 403', async () => {
    const e = env()
    await seedSparkDatabase(e, { id: 'sp1' })
    // u2 has no permission
    const headers = await bearer(e, 'u2', 'member')
    const res = await callWorker(e, '/spark-ui/?db=sp1', { headers })
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'Forbidden' })
  })

  it('first hit (?db=<id>) verifies auth, sets signed HttpOnly cookie and 302 redirects to /spark-ui/', async () => {
    const e = env()
    await seedSparkDatabase(e, { id: 'sp1' })
    await grantPermission(e, 'u1', 'sp1', 'read')

    const headers = await bearer(e, 'u1', 'member')
    const res = await callWorker(e, '/spark-ui/?db=sp1', { headers })
    expect(res.status).toBe(302)
    expect(res.headers.get('Location')).toBe('/spark-ui/')

    const setCookie = res.headers.get('Set-Cookie') ?? ''
    expect(setCookie).toContain('spark_ui_session=')
    expect(setCookie).toContain('HttpOnly')
    expect(setCookie).toContain('Path=/spark-ui')
    expect(setCookie).toContain('SameSite=Lax')
  })

  it('first hit works with ?token= query parameter as well', async () => {
    const e = env()
    await seedSparkDatabase(e, { id: 'sp1' })
    const tokenHeader = await bearer(e, 'a1', 'admin')
    const token = tokenHeader.Authorization.replace('Bearer ', '')

    const res = await callWorker(e, `/spark-ui/?db=sp1&token=${token}`)
    expect(res.status).toBe(302)
    expect(res.headers.get('Location')).toBe('/spark-ui/')
    expect(res.headers.get('Set-Cookie')).toContain('spark_ui_session=')
  })
})

describe('/spark-ui proxying with signed cookie', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    fetchMock = vi.fn()
    globalThis.fetch = fetchMock as unknown as typeof fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  async function setupSession(e: Env, userId = 'u1', role: 'admin' | 'member' = 'member'): Promise<string> {
    await seedSparkDatabase(e, { id: 'sp1' })
    if (role !== 'admin') {
      await grantPermission(e, userId, 'sp1', 'read')
    }
    const headers = await bearer(e, userId, role)
    const res = await callWorker(e, '/spark-ui/?db=sp1', { headers })
    const cookieHeader = res.headers.get('Set-Cookie') ?? ''
    const match = cookieHeader.match(/spark_ui_session=([^;]+)/)
    expect(match).not.toBeNull()
    return match![1]!
  }

  it('rejects /spark-ui/ without cookie and without ?db= with 401', async () => {
    const e = env()
    const headers = await bearer(e, 'a1', 'admin')
    const res = await callWorker(e, '/spark-ui/', { headers })
    expect(res.status).toBe(401)
  })

  it('rejects forged or corrupted cookie with 401', async () => {
    const e = env()
    const res = await callWorker(e, '/spark-ui/', {
      headers: { Cookie: 'spark_ui_session=forged.invalid.token' },
    })
    expect(res.status).toBe(401)
  })

  it('proxies /spark-ui and /spark-ui/ to upstream root (/) with UI platform token', async () => {
    const e = env()
    const cookie = await setupSession(e)

    fetchMock.mockResolvedValueOnce(
      new Response('<html>Spark UI Home</html>', {
        status: 200,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      })
    )

    const res = await callWorker(e, '/spark-ui/', {
      headers: {
        Cookie: `spark_ui_session=${cookie}`,
        Authorization: 'Bearer original-caller-token-should-be-stripped',
      },
    })

    expect(res.status).toBe(200)
    expect(await res.text()).toBe('<html>Spark UI Home</html>')

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [calledUrl, calledInit] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(calledUrl).toBe(`${UI_URL}/`)
    const headers = new Headers(calledInit.headers)
    expect(headers.get('Authorization')).toBe(`Bearer ${UI_TOKEN}`)
    // Original caller token must not be forwarded
    expect(headers.get('Authorization')).not.toContain('original-caller-token')
  })

  it('proxies subpaths /spark-ui/proxy/<app-id>/jobs/ to upstream /proxy/<app-id>/jobs/', async () => {
    const e = env()
    const cookie = await setupSession(e)

    fetchMock.mockResolvedValueOnce(
      new Response('<html>Jobs page</html>', {
        status: 200,
        headers: { 'Content-Type': 'text/html' },
      })
    )

    const res = await callWorker(e, '/spark-ui/proxy/app-20261128-0001/jobs/?field=val', {
      headers: { Cookie: `spark_ui_session=${cookie}` },
    })

    expect(res.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [calledUrl] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(calledUrl).toBe(`${UI_URL}/proxy/app-20261128-0001/jobs/?field=val`)
  })

  it('proxies static assets and passes through Content-Type', async () => {
    const e = env()
    const cookie = await setupSession(e)

    fetchMock.mockResolvedValueOnce(
      new Response(new Uint8Array([1, 2, 3, 4]), {
        status: 200,
        headers: { 'Content-Type': 'image/png' },
      })
    )

    const res = await callWorker(e, '/spark-ui/static/spark-logo.png', {
      headers: { Cookie: `spark_ui_session=${cookie}` },
    })

    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('image/png')
    const bodyBytes = await res.arrayBuffer()
    expect(new Uint8Array(bodyBytes)).toEqual(new Uint8Array([1, 2, 3, 4]))
  })

  it('rewrites relative and absolute Location headers back into /spark-ui prefix', async () => {
    const e = env()
    const cookie = await setupSession(e)

    // Case 1: relative redirect
    fetchMock.mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { Location: '/proxy/app-1/jobs/' },
      })
    )
    const res1 = await callWorker(e, '/spark-ui/', {
      headers: { Cookie: `spark_ui_session=${cookie}` },
    })
    expect(res1.status).toBe(302)
    expect(res1.headers.get('Location')).toBe('/spark-ui/proxy/app-1/jobs/')

    // Case 2: absolute redirect matching UI origin
    fetchMock.mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { Location: `${UI_URL}/proxy/app-2/stages/?x=1` },
      })
    )
    const res2 = await callWorker(e, '/spark-ui/proxy/app-2/', {
      headers: { Cookie: `spark_ui_session=${cookie}` },
    })
    expect(res2.status).toBe(302)
    expect(res2.headers.get('Location')).toBe('/spark-ui/proxy/app-2/stages/?x=1')
    expect(res2.headers.get('Location')).not.toContain(UI_URL)

    // Case 3: redirect to root /
    fetchMock.mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { Location: '/' },
      })
    )
    const res3 = await callWorker(e, '/spark-ui/something', {
      headers: { Cookie: `spark_ui_session=${cookie}` },
    })
    expect(res3.status).toBe(302)
    expect(res3.headers.get('Location')).toBe('/spark-ui/')
  })

  it('never leaks ui_url or ui_platform_token in headers or response', async () => {
    const e = env()
    const cookie = await setupSession(e)

    fetchMock.mockResolvedValueOnce(
      new Response('<div>Hello</div>', {
        status: 200,
        headers: { 'Content-Type': 'text/html' },
      })
    )

    const res = await callWorker(e, '/spark-ui/jobs/', {
      headers: { Cookie: `spark_ui_session=${cookie}` },
    })

    for (const [k, v] of res.headers.entries()) {
      expect(k).not.toContain(UI_TOKEN)
      expect(v).not.toContain(UI_TOKEN)
      expect(v).not.toContain(UI_URL)
    }
  })

  it('returns 502 when upstream Spark UI is unreachable, without leaking tokens', async () => {
    const e = env()
    const cookie = await setupSession(e)

    fetchMock.mockRejectedValueOnce(new Error('Connection refused to published port'))

    const res = await callWorker(e, '/spark-ui/jobs/', {
      headers: { Cookie: `spark_ui_session=${cookie}` },
    })

    expect(res.status).toBe(502)
    const json = (await res.json()) as { error: string }
    expect(json.error).toBe('Spark UI service unreachable')
    expect(JSON.stringify(json)).not.toContain(UI_URL)
    expect(JSON.stringify(json)).not.toContain(UI_TOKEN)
  })
})
