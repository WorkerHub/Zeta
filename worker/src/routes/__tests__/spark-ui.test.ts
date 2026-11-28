import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getMigrations } from '../../lib/migrations'
import { sealSecret } from '../../lib/secrets'
import type { Env } from '../../types'
import { rewriteSparkUiHtml, rewriteSparkUiLocation, rewriteSparkUiUrl } from '../spark-ui'
import { bearer, callWorker, fakeEnv, postJson } from './fakes'
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

  it('rejects ?token= query parameter on /spark-ui/ (token in URL fallback is removed)', async () => {
    const e = env()
    await seedSparkDatabase(e, { id: 'sp1' })
    const tokenHeader = await bearer(e, 'a1', 'admin')
    const token = tokenHeader.Authorization.replace('Bearer ', '')

    const res = await callWorker(e, `/spark-ui/?db=sp1&token=${token}`)
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'Unauthorized' })
  })

  it('does NOT accept ?token= query parameter for /api/* endpoints', async () => {
    const e = env()
    const tokenHeader = await bearer(e, 'a1', 'admin')
    const token = tokenHeader.Authorization.replace('Bearer ', '')

    // /api/profile must refuse query param token and demand Authorization header
    const res = await callWorker(e, `/api/profile?token=${token}`)
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'Unauthorized' })
  })

  it('POST /api/auth/logout clears spark_ui_session cookie', async () => {
    const e = env()
    const res = await callWorker(e, '/api/auth/logout', { method: 'POST' })
    expect(res.status).toBe(200)
    const setCookie = res.headers.get('Set-Cookie') ?? ''
    expect(setCookie).toContain('spark_ui_session=;')
    expect(setCookie).toContain('Max-Age=0')
    expect(setCookie).toContain('Path=/spark-ui')
  })
})

describe('POST /api/spark-ui/session', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    fetchMock = vi.fn()
    globalThis.fetch = fetchMock as unknown as typeof fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('blocks unauthenticated requests with 401', async () => {
    const e = env()
    await seedSparkDatabase(e, { id: 'sp1' })
    const res = await callWorker(e, '/api/spark-ui/session', postJson({ db: 'sp1' }))
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'Unauthorized' })
  })

  it('rejects invalid or missing db in body with 400', async () => {
    const e = env()
    const headers = await bearer(e, 'a1', 'admin')
    const res1 = await callWorker(e, '/api/spark-ui/session', postJson({}, { headers }))
    expect(res1.status).toBe(400)
    expect(await res1.json()).toEqual({ error: 'db is required' })

    const res2 = await callWorker(e, '/api/spark-ui/session', postJson({ db: '   ' }, { headers }))
    expect(res2.status).toBe(400)
    expect(await res2.json()).toEqual({ error: 'db is required' })

    const res3 = await callWorker(e, '/api/spark-ui/session', postJson({ db: 123 }, { headers }))
    expect(res3.status).toBe(400)
    expect(await res3.json()).toEqual({ error: 'db is required' })
  })

  it('rejects non-existent database with 404', async () => {
    const e = env()
    const headers = await bearer(e, 'a1', 'admin')
    const res = await callWorker(e, '/api/spark-ui/session', postJson({ db: 'nonexistent' }, { headers }))
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'Database not found' })
  })

  it('rejects non-spark database with 404', async () => {
    const e = env()
    await seedSparkDatabase(e, { id: 'pg1', kind: 'postgres' })
    const headers = await bearer(e, 'a1', 'admin')
    const res = await callWorker(e, '/api/spark-ui/session', postJson({ db: 'pg1' }, { headers }))
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'Database is not a Spark database' })
  })

  it('rejects spark database without UI configured with 404', async () => {
    const e = env()
    await seedSparkDatabase(e, { id: 'sp_no_ui', withUi: false })
    const headers = await bearer(e, 'a1', 'admin')
    const res = await callWorker(e, '/api/spark-ui/session', postJson({ db: 'sp_no_ui' }, { headers }))
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'Spark UI not configured' })
  })

  it('rejects member without permission with 403', async () => {
    const e = env()
    await seedSparkDatabase(e, { id: 'sp1' })
    const headers = await bearer(e, 'u2', 'member')
    const res = await callWorker(e, '/api/spark-ui/session', postJson({ db: 'sp1' }, { headers }))
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'Forbidden' })
  })

  it('allows admin to create session and sets signed HttpOnly cookie with 204', async () => {
    const e = env()
    await seedSparkDatabase(e, { id: 'sp1' })
    const headers = await bearer(e, 'a1', 'admin')
    const res = await callWorker(e, '/api/spark-ui/session', postJson({ db: 'sp1' }, { headers }))
    expect(res.status).toBe(204)
    expect(await res.text()).toBe('')

    const setCookie = res.headers.get('Set-Cookie') ?? ''
    expect(setCookie).toContain('spark_ui_session=')
    expect(setCookie).toContain('HttpOnly')
    expect(setCookie).toContain('Path=/spark-ui')
    expect(setCookie).toContain('Max-Age=86400')
    expect(setCookie).toContain('SameSite=Lax')
  })

  it('allows member with read permission to create session with 204', async () => {
    const e = env()
    await seedSparkDatabase(e, { id: 'sp1' })
    await grantPermission(e, 'u1', 'sp1', 'read')

    const headers = await bearer(e, 'u1', 'member')
    const res = await callWorker(e, '/api/spark-ui/session', postJson({ db: 'sp1' }, { headers }))
    expect(res.status).toBe(204)
    expect(await res.text()).toBe('')

    const setCookie = res.headers.get('Set-Cookie') ?? ''
    expect(setCookie).toContain('spark_ui_session=')
    expect(setCookie).toContain('Path=/spark-ui')
  })

  it('sets Secure flag when request arrives over HTTPS', async () => {
    const e = env()
    await seedSparkDatabase(e, { id: 'sp1' })
    const headers = await bearer(e, 'a1', 'admin')
    const res = await callWorker(e, 'https://localhost:8787/api/spark-ui/session', postJson({ db: 'sp1' }, { headers }))
    expect(res.status).toBe(204)
    const setCookie = res.headers.get('Set-Cookie') ?? ''
    expect(setCookie).toContain('Secure')
  })

  it('never leaks ui_url or ui_platform_token in session response', async () => {
    const e = env()
    await seedSparkDatabase(e, { id: 'sp1' })
    const headers = await bearer(e, 'a1', 'admin')
    const res = await callWorker(e, '/api/spark-ui/session', postJson({ db: 'sp1' }, { headers }))
    for (const [k, v] of res.headers.entries()) {
      expect(k).not.toContain(UI_TOKEN)
      expect(v).not.toContain(UI_TOKEN)
      expect(v).not.toContain(UI_URL)
    }
  })

  it('cookie issued by POST /api/spark-ui/session successfully authenticates subsequent /spark-ui proxy requests', async () => {
    const e = env()
    await seedSparkDatabase(e, { id: 'sp1' })
    await grantPermission(e, 'u1', 'sp1', 'read')

    const headers = await bearer(e, 'u1', 'member')
    const sessionRes = await callWorker(e, '/api/spark-ui/session', postJson({ db: 'sp1' }, { headers }))
    expect(sessionRes.status).toBe(204)
    const cookieHeader = sessionRes.headers.get('Set-Cookie') ?? ''
    const match = cookieHeader.match(/spark_ui_session=([^;]+)/)
    expect(match).not.toBeNull()
    const cookie = match![1]!

    fetchMock.mockResolvedValueOnce(
      new Response('<html>Spark UI Via Guided Auth</html>', {
        status: 200,
        headers: { 'Content-Type': 'text/html' },
      })
    )

    const proxyRes = await callWorker(e, '/spark-ui/jobs/', {
      headers: { Cookie: `spark_ui_session=${cookie}` },
    })
    expect(proxyRes.status).toBe(200)
    expect(await proxyRes.text()).toBe('<html>Spark UI Via Guided Auth</html>')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [calledUrl, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(calledUrl).toBe(`${UI_URL}/jobs/`)
    expect((init.headers as Headers).get('Authorization')).toBe(`Bearer ${UI_TOKEN}`)
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

    // Case 4: relative redirect with ../ resolved against current request URL
    fetchMock.mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { Location: '../jobs' },
      })
    )
    const res4 = await callWorker(e, '/spark-ui/proxy/app-1/stages/detail', {
      headers: { Cookie: `spark_ui_session=${cookie}` },
    })
    expect(res4.status).toBe(302)
    expect(res4.headers.get('Location')).toBe('/spark-ui/proxy/app-1/jobs')

    // Case 5: relative redirect with excessive ../ never escapes /spark-ui
    fetchMock.mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { Location: '../../../../escaped' },
      })
    )
    const res5 = await callWorker(e, '/spark-ui/proxy/app-1/', {
      headers: { Cookie: `spark_ui_session=${cookie}` },
    })
    expect(res5.status).toBe(302)
    expect(res5.headers.get('Location')).toMatch(/^\/spark-ui\//)
    expect(res5.headers.get('Location')).toBe('/spark-ui/escaped')
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

  describe('rewriteSparkUiUrl', () => {
    it('leaves external absolute URLs and anchors intact', () => {
      expect(rewriteSparkUiUrl('https://spark.apache.org/docs', UI_URL)).toBe('https://spark.apache.org/docs')
      expect(rewriteSparkUiUrl('//cdn.example.com/lib.css', UI_URL)).toBe('//cdn.example.com/lib.css')
      expect(rewriteSparkUiUrl('#section', UI_URL)).toBe('#section')
      expect(rewriteSparkUiUrl('javascript:void(0)', UI_URL)).toBe('javascript:void(0)')
      expect(rewriteSparkUiUrl('data:image/png;base64,...', UI_URL)).toBe('data:image/png;base64,...')
    })

    it('does not double prefix paths that already start with /spark-ui', () => {
      expect(rewriteSparkUiUrl('/spark-ui/static/webui.css', UI_URL)).toBe('/spark-ui/static/webui.css')
      expect(rewriteSparkUiUrl('/spark-ui/jobs/', UI_URL)).toBe('/spark-ui/jobs/')
      expect(rewriteSparkUiUrl('/spark-ui', UI_URL)).toBe('/spark-ui')
      expect(rewriteSparkUiUrl('/spark-ui?db=sp1', UI_URL)).toBe('/spark-ui?db=sp1')
    })

    it('rewrites root-relative paths by prepending /spark-ui', () => {
      expect(rewriteSparkUiUrl('/static/bootstrap.min.css', UI_URL)).toBe('/spark-ui/static/bootstrap.min.css')
      expect(rewriteSparkUiUrl('/static/webui.js', UI_URL)).toBe('/spark-ui/static/webui.js')
      expect(rewriteSparkUiUrl('/jobs/', UI_URL)).toBe('/spark-ui/jobs/')
      expect(rewriteSparkUiUrl('/stages/stage/?id=1', UI_URL)).toBe('/spark-ui/stages/stage/?id=1')
      expect(rewriteSparkUiUrl('/', UI_URL)).toBe('/spark-ui/')
      expect(rewriteSparkUiUrl('/?sort=id', UI_URL)).toBe('/spark-ui/?sort=id')
    })

    it('rewrites relative paths (naked, ./, ../) into /spark-ui', () => {
      expect(rewriteSparkUiUrl('static/webui.css', UI_URL)).toBe('/spark-ui/static/webui.css')
      expect(rewriteSparkUiUrl('jobs/job?id=1', UI_URL)).toBe('/spark-ui/jobs/job?id=1')
      expect(rewriteSparkUiUrl('./static/sorttable.js', UI_URL)).toBe('/spark-ui/static/sorttable.js')
      expect(rewriteSparkUiUrl('../static/table.js', UI_URL)).toBe('/spark-ui/static/table.js')
    })

    it('rewrites absolute URLs matching upstream ui_url into /spark-ui', () => {
      expect(rewriteSparkUiUrl(`${UI_URL}/static/spark-logo.png`, UI_URL)).toBe('/spark-ui/static/spark-logo.png')
      expect(rewriteSparkUiUrl(`${UI_URL}/jobs/`, UI_URL)).toBe('/spark-ui/jobs/')
      expect(rewriteSparkUiUrl(`${UI_URL}/`, UI_URL)).toBe('/spark-ui/')
    })

    it('rewrites upstream ui_url with sub-path prefix correctly', () => {
      const subUiUrl = 'https://spark.publish.dev/proxy/app-1'
      expect(rewriteSparkUiUrl('https://spark.publish.dev/proxy/app-1/jobs/', subUiUrl)).toBe('/spark-ui/jobs/')
      expect(rewriteSparkUiUrl('https://spark.publish.dev/proxy/app-1/static/webui.css', subUiUrl)).toBe(
        '/spark-ui/static/webui.css'
      )
    })

    it('rewrites arbitrary-host absolute URLs already carrying the /spark-ui prefix to same-origin', () => {
      // Upstream Spark configured with a fixed proxyBase host (spark.ui.reverseProxy=true) that
      // differs from the private ui_url — its resources arrive as absolute URLs like
      // https://zeta.oneboy.app/spark-ui/proxy/local-<appId>/static/webui.css.
      const proxyBase = 'https://zeta.oneboy.app'
      expect(rewriteSparkUiUrl(`${proxyBase}/spark-ui/proxy/local-1795879633814/static/webui.css`, UI_URL)).toBe(
        '/spark-ui/proxy/local-1795879633814/static/webui.css'
      )
      expect(rewriteSparkUiUrl(`${proxyBase}/spark-ui/proxy/local-1795879633814/static/sorttable.js`, UI_URL)).toBe(
        '/spark-ui/proxy/local-1795879633814/static/sorttable.js'
      )
      expect(rewriteSparkUiUrl(`${proxyBase}/spark-ui/jobs/`, UI_URL)).toBe('/spark-ui/jobs/')
      expect(rewriteSparkUiUrl(`${proxyBase}/spark-ui/`, UI_URL)).toBe('/spark-ui/')
      expect(rewriteSparkUiUrl(`${proxyBase}/spark-ui?db=sp1`, UI_URL)).toBe('/spark-ui?db=sp1')
    })

    it('does not double prefix an absolute ui_url URL whose path already starts with /spark-ui', () => {
      expect(rewriteSparkUiUrl(`${UI_URL}/spark-ui/static/webui.css`, UI_URL)).toBe('/spark-ui/static/webui.css')
      expect(rewriteSparkUiUrl(`${UI_URL}/spark-ui/jobs/`, UI_URL)).toBe('/spark-ui/jobs/')
    })
  })

  describe('rewriteSparkUiLocation', () => {
    it('normalises an absolute Location carrying the /spark-ui prefix (proxyBase host) to same-origin', () => {
      const proxyBase = 'https://zeta.oneboy.app'
      expect(rewriteSparkUiLocation(`${proxyBase}/spark-ui/proxy/local-1795879633814/SQL/`, UI_URL)).toBe(
        '/spark-ui/proxy/local-1795879633814/SQL/'
      )
      expect(rewriteSparkUiLocation(`${proxyBase}/spark-ui/jobs/`, UI_URL)).toBe('/spark-ui/jobs/')
      expect(rewriteSparkUiLocation(`${proxyBase}/spark-ui/`, UI_URL)).toBe('/spark-ui/')
    })

    it('keeps rewriting absolute ui_url Locations to /spark-ui and leaves external hosts untouched', () => {
      expect(rewriteSparkUiLocation(`${UI_URL}/proxy/app-1/jobs/`, UI_URL)).toBe('/spark-ui/proxy/app-1/jobs/')
      expect(rewriteSparkUiLocation('https://spark.apache.org/docs', UI_URL)).toBe('https://spark.apache.org/docs')
    })

    it('keeps rewriting relative Locations into /spark-ui prefix', () => {
      expect(rewriteSparkUiLocation('/proxy/app-1/jobs/', UI_URL)).toBe('/spark-ui/proxy/app-1/jobs/')
      expect(rewriteSparkUiLocation('/', UI_URL)).toBe('/spark-ui/')
    })
  })

  describe('rewriteSparkUiHtml', () => {
    it('rewrites stylesheet links and script tags in HTML head and body', () => {
      const raw = `
        <!DOCTYPE html>
        <html>
          <head>
            <link rel="stylesheet" href="/static/bootstrap.min.css" type="text/css"/>
            <link rel="stylesheet" href="/static/webui.css" type="text/css"/>
            <link rel="stylesheet" href="static/timeline-view.css" type="text/css"/>
            <script src="/static/sorttable.js"></script>
            <script src="/static/webui.js"></script>
          </head>
          <body>
            <a href="/jobs/">Jobs</a>
            <a href="/stages/">Stages</a>
            <a href="/">Home</a>
            <img src="/static/spark-logo.svg"/>
            <form action="/jobs/job/kill" method="POST"></form>
          </body>
        </html>
      `
      const rewritten = rewriteSparkUiHtml(raw, UI_URL)
      expect(rewritten).toContain('href="/spark-ui/static/bootstrap.min.css"')
      expect(rewritten).toContain('href="/spark-ui/static/webui.css"')
      expect(rewritten).toContain('href="/spark-ui/static/timeline-view.css"')
      expect(rewritten).toContain('src="/spark-ui/static/sorttable.js"')
      expect(rewritten).toContain('src="/spark-ui/static/webui.js"')
      expect(rewritten).toContain('href="/spark-ui/jobs/"')
      expect(rewritten).toContain('href="/spark-ui/stages/"')
      expect(rewritten).toContain('href="/spark-ui/"')
      expect(rewritten).toContain('src="/spark-ui/static/spark-logo.svg"')
      expect(rewritten).toContain('action="/spark-ui/jobs/job/kill"')
      expect(rewritten).not.toContain('/spark-ui/spark-ui')
    })

    it('rewrites inline setUIRoot and uiRoot scripts and api/v1 calls', () => {
      const raw = `
        <script>setUIRoot(''); var uiRoot = "";</script>
        <script>
          $.getJSON('/api/v1/applications/app-1/jobs', function(data) {});
        </script>
      `
      const rewritten = rewriteSparkUiHtml(raw, UI_URL)
      expect(rewritten).toContain("setUIRoot('/spark-ui')")
      expect(rewritten).toContain('var uiRoot = "/spark-ui"')
      expect(rewritten).toContain('/spark-ui/api/v1/applications/app-1/jobs')
    })

    it('rewrites base tag href to /spark-ui/', () => {
      const raw = '<head><base href="/"><link rel="stylesheet" href="static/webui.css"></head>'
      const rewritten = rewriteSparkUiHtml(raw, UI_URL)
      expect(rewritten).toContain('<base href="/spark-ui/">')
      expect(rewritten).toContain('href="/spark-ui/static/webui.css"')
    })

    it('normalises a proxyBase-hosted base href instead of hardcoding /spark-ui/', () => {
      const proxyBase = 'https://zeta.oneboy.app'
      const raw = `<head><base href="${proxyBase}/spark-ui/proxy/local-1795879633814/"></head>`
      const rewritten = rewriteSparkUiHtml(raw, UI_URL)
      expect(rewritten).not.toContain(proxyBase)
      expect(rewritten).toContain('<base href="/spark-ui/proxy/local-1795879633814/">')
    })

    it('strips all mentions of upstream ui_url origin so private address is never leaked', () => {
      const raw = `
        <a href="${UI_URL}/jobs/">Jobs</a>
        <img src="${UI_URL}/static/logo.png"/>
        <div>Server: ${UI_URL}</div>
      `
      const rewritten = rewriteSparkUiHtml(raw, UI_URL)
      expect(rewritten).not.toContain(UI_URL)
      expect(rewritten).toContain('href="/spark-ui/jobs/"')
      expect(rewritten).toContain('src="/spark-ui/static/logo.png"')
    })

    it('rewrites absolute proxyBase-host resource links to same-origin /spark-ui paths', () => {
      // The upstream Spark emits absolute URLs with its configured proxyBase host (a different
      // host from the private ui_url). These must be dropped to relative so the browser fetches
      // them from the current origin and CSP style-src/script-src 'self' admits them.
      const proxyBase = 'https://zeta.oneboy.app'
      const raw = `
        <link rel="stylesheet" href="${proxyBase}/spark-ui/proxy/local-1795879633814/static/bootstrap.min.css" type="text/css"/>
        <link rel="stylesheet" href="${proxyBase}/spark-ui/proxy/local-1795879633814/static/webui.css" type="text/css"/>
        <script src="${proxyBase}/spark-ui/proxy/local-1795879633814/static/webui.js"></script>
        <img src="${proxyBase}/spark-ui/proxy/local-1795879633814/static/spark-logo.svg"/>
        <a href="${proxyBase}/spark-ui/proxy/local-1795879633814/stages/">Stages</a>
      `
      const rewritten = rewriteSparkUiHtml(raw, UI_URL)
      expect(rewritten).not.toContain(proxyBase)
      expect(rewritten).toContain('href="/spark-ui/proxy/local-1795879633814/static/bootstrap.min.css"')
      expect(rewritten).toContain('href="/spark-ui/proxy/local-1795879633814/static/webui.css"')
      expect(rewritten).toContain('src="/spark-ui/proxy/local-1795879633814/static/webui.js"')
      expect(rewritten).toContain('src="/spark-ui/proxy/local-1795879633814/static/spark-logo.svg"')
      expect(rewritten).toContain('href="/spark-ui/proxy/local-1795879633814/stages/"')
    })
  })

  describe('proxy response rewriting and header forwarding', () => {
    it('forwards X-Forwarded-Context and X-Forwarded-Prefix to upstream', async () => {
      const e = env()
      const cookie = await setupSession(e)

      fetchMock.mockResolvedValueOnce(
        new Response('<div>Jobs Content</div>', {
          status: 200,
          headers: { 'Content-Type': 'text/html' },
        })
      )

      const res = await callWorker(e, '/spark-ui/jobs/', {
        headers: { Cookie: `spark_ui_session=${cookie}` },
      })
      expect(res.status).toBe(200)
      expect(fetchMock).toHaveBeenCalledTimes(1)
      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
      const sentHeaders = init.headers as Headers
      expect(sentHeaders.get('X-Forwarded-Context')).toBe('/spark-ui')
      expect(sentHeaders.get('X-Forwarded-Prefix')).toBe('/spark-ui')
    })

    it('rewrites HTML response body on proxy hit to prevent unstyled pages', async () => {
      const e = env()
      const cookie = await setupSession(e)

      const upstreamHtml = `
        <!DOCTYPE html>
        <html>
          <head>
            <link rel="stylesheet" href="/static/bootstrap.min.css" type="text/css"/>
            <link rel="stylesheet" href="/static/webui.css" type="text/css"/>
            <script src="/static/webui.js"></script>
            <script>setUIRoot('');</script>
          </head>
          <body>
            <div class="container-fluid">
              <a href="/stages/">Stages</a>
              <a href="/jobs/">Jobs</a>
            </div>
          </body>
        </html>
      `
      fetchMock.mockResolvedValueOnce(
        new Response(upstreamHtml, {
          status: 200,
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        })
      )

      const res = await callWorker(e, '/spark-ui/jobs/', {
        headers: { Cookie: `spark_ui_session=${cookie}` },
      })
      expect(res.status).toBe(200)
      const body = await res.text()
      expect(body).toContain('href="/spark-ui/static/bootstrap.min.css"')
      expect(body).toContain('href="/spark-ui/static/webui.css"')
      expect(body).toContain('src="/spark-ui/static/webui.js"')
      expect(body).toContain("setUIRoot('/spark-ui')")
      expect(body).toContain('href="/spark-ui/stages/"')
      expect(body).toContain('href="/spark-ui/jobs/"')
      expect(body).not.toContain('href="/static/')
      expect(body).not.toContain('src="/static/')
    })

    it('sanitizes upstream ui_url in JSON responses to prevent leak', async () => {
      const e = env()
      const cookie = await setupSession(e)

      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ spark_ui_link: `${UI_URL}/jobs/` }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      )

      const res = await callWorker(e, '/spark-ui/api/v1/applications', {
        headers: { Cookie: `spark_ui_session=${cookie}` },
      })
      expect(res.status).toBe(200)
      const json = await res.json()
      expect(json).toEqual({ spark_ui_link: '/spark-ui/jobs/' })
      const raw = JSON.stringify(json)
      expect(raw).not.toContain(UI_URL)
    })
  })
})
