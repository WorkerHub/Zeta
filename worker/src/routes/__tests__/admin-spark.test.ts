import { afterEach, describe, expect, it, vi } from 'vitest'
import { getMigrations } from '../../lib/migrations'
import { openSecret, sealSecret } from '../../lib/secrets'
import type { Env } from '../../types'
import { bearer, callWorker, fakeEnv, postJson } from './fakes'
import { sqliteD1 } from './sqlite-d1'

// Registering SparkSQL targets in the admin panel: both tokens are proven against the published port
// before anything is stored, the sealed payload carries all three fields, and no token ever comes
// back out.

const spark = vi.hoisted(() => ({
  queue: [] as Array<{ kind: 'ok' | 'fail'; version?: string; message?: string; code?: string; errorKind?: string }>,
  calls: [] as Array<{ url: string; platform: string; app: string; session?: string }>,
}))

vi.mock('../../lib/spark-executor', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/spark-executor')>()
  return {
    ...actual,
    testSparkConnection: async (
      access: { url: string; platform_token: string; app_token: string },
      session?: string
    ) => {
      spark.calls.push({ url: access.url, platform: access.platform_token, app: access.app_token, session })
      const next = spark.queue.shift()
      if (!next || next.kind === 'ok') return { server_version: next?.version ?? '3.5.3' }
      throw new actual.SparkQueryError(
        next.message ?? 'The Spark machine is stopped.',
        (next.errorKind ?? 'stopped') as never,
        (next.code ?? 'spark_stopped') as never
      )
    },
  }
})

const HOST = 'spark-3f9a.publish.example.dev'
const URL = `https://${HOST}`
const PLATFORM = '{{SECRET_ijee567b}}'
const APP = '{{SECRET_8x2jkw2z}}'

const body = (over: Record<string, unknown> = {}) => ({
  kind: 'spark',
  connection_url: URL,
  platform_token: PLATFORM,
  app_token: APP,
  ...over,
})

afterEach(() => {
  spark.queue.length = 0
  spark.calls.length = 0
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

const adminHeaders = (e: Env) => bearer(e, 'a1', 'admin')

async function listRows(e: Env) {
  const res = await e.DB.prepare(`SELECT * FROM d1_databases`).all<Record<string, unknown>>()
  return res.results
}

describe('POST /api/admin/databases/test-connection (kind=spark)', () => {
  it('proves the registration and reports the engine and version', async () => {
    const e = env()
    spark.queue.push({ kind: 'ok', version: '3.5.3' })
    const res = await callWorker(
      e,
      '/api/admin/databases/test-connection',
      postJson(body(), { headers: await adminHeaders(e) })
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as { ok: boolean; kind: string; server_version: string; latency_ms: number }
    expect(json).toMatchObject({ ok: true, kind: 'spark', server_version: '3.5.3' })
    expect(typeof json.latency_ms).toBe('number')
    // The address is normalised before the executor sees it: no trailing slash, no query string, and
    // the admin's own id rides along as the session
    expect(spark.calls).toEqual([{ url: URL, platform: PLATFORM, app: APP, session: 'a1' }])
  })

  it('requires both tokens and an https address, without calling the executor', async () => {
    const e = env()
    for (const over of [
      { platform_token: '' },
      { app_token: undefined },
      { connection_url: 'http://spark-3f9a.publish.example.dev' },
      { connection_url: `https://user:pw@${HOST}` },
      { connection_url: `${URL}/?_token=${APP}` },
    ]) {
      const res = await callWorker(
        e,
        '/api/admin/databases/test-connection',
        postJson(body(over), { headers: await adminHeaders(e) })
      )
      expect(res.status, JSON.stringify(over)).toBe(400)
      expect(((await res.json()) as { error: string }).error).not.toContain(PLATFORM)
    }
    expect(spark.calls).toEqual([])
  })

  it('reports a failed test with the Spark code, so the form can render it', async () => {
    const e = env()
    spark.queue.push({
      kind: 'fail',
      message: 'The Spark machine is starting or temporarily unreachable.',
      code: 'spark_not_ready',
      errorKind: 'starting',
    })
    const res = await callWorker(
      e,
      '/api/admin/databases/test-connection',
      postJson(body(), { headers: await adminHeaders(e) })
    )
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ code: 'spark_not_ready' })
  })
})

describe('POST /api/admin/databases (kind=spark)', () => {
  it('stores the target only after a successful test, with all three fields sealed', async () => {
    const e = env()
    spark.queue.push({ kind: 'ok' })
    const res = await callWorker(e, '/api/admin/databases', postJson(body(), { headers: await adminHeaders(e) }))
    expect(res.status).toBe(201)
    const { id } = (await res.json()) as { id: string }

    const rows = await listRows(e)
    expect(rows).toHaveLength(1)
    const row = rows[0]!
    expect(row).toMatchObject({
      id,
      name: HOST, // default display name from the publish host
      kind: 'spark',
      cf_database_id: null,
      binding_name: `spark:${id}`,
      is_active: 1,
    })
    const sealed = row.connection_secret as string
    expect(sealed.startsWith('enc:v1:')).toBe(true)
    // Neither token is stored in the clear anywhere in the row
    expect(JSON.stringify(row)).not.toContain(PLATFORM)
    expect(JSON.stringify(row)).not.toContain(APP)
    expect(JSON.parse(await openSecret(e, sealed))).toEqual({ url: URL, platform_token: PLATFORM, app_token: APP })
  })

  it('keeps the admin-chosen name when one is sent', async () => {
    const e = env()
    spark.queue.push({ kind: 'ok' })
    await callWorker(
      e,
      '/api/admin/databases',
      postJson(body({ name: 'Practice' }), { headers: await adminHeaders(e) })
    )
    expect((await listRows(e))[0]!.name).toBe('Practice')
  })

  it('does not store a target whose connection test failed', async () => {
    const e = env()
    spark.queue.push({
      kind: 'fail',
      message: 'The Spark machine is stopped.',
      code: 'spark_stopped',
      errorKind: 'stopped',
    })
    const res = await callWorker(e, '/api/admin/databases', postJson(body(), { headers: await adminHeaders(e) }))
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ code: 'spark_stopped' })
    expect(await listRows(e)).toEqual([])
  })

  it('does not store a target that carries its token in the URL', async () => {
    const e = env()
    const res = await callWorker(
      e,
      '/api/admin/databases',
      postJson(body({ connection_url: `${URL}/?token=${APP}` }), { headers: await adminHeaders(e) })
    )
    expect(res.status).toBe(400)
    expect(await listRows(e)).toEqual([])
    expect(spark.calls).toEqual([])
  })
})

describe('GET /api/admin/databases (kind=spark)', () => {
  it('never returns the sealed payload for a spark row', async () => {
    const e = env()
    spark.queue.push({ kind: 'ok' })
    await callWorker(e, '/api/admin/databases', postJson(body(), { headers: await adminHeaders(e) }))

    const res = await callWorker(e, '/api/admin/databases', { headers: await adminHeaders(e) })
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).not.toContain('connection_secret')
    expect(text).not.toContain('enc:v1:')
    expect(text).not.toContain(PLATFORM)
    expect(text).not.toContain(APP)
    const json = JSON.parse(text) as { results: Array<Record<string, unknown>> }
    expect(json.results[0]).toMatchObject({ kind: 'spark', has_connection: true, is_app_db: false })
  })
})

describe('PATCH /api/admin/databases/:id (kind=spark)', () => {
  async function seed(e: Env): Promise<string> {
    const sealed = await sealSecret(e, JSON.stringify({ url: URL, platform_token: PLATFORM, app_token: APP }))
    await e.DB.prepare(
      `INSERT INTO d1_databases (id, name, binding_name, cf_database_id, kind, connection_secret, is_active, created_at)
       VALUES ('sp1', 'spark', 'spark:sp1', NULL, 'spark', ?1, 1, 0)`
    )
      .bind(sealed)
      .run()
    return 'sp1'
  }

  it('re-tests every field before replacing the sealed payload', async () => {
    const e = env()
    const id = await seed(e)
    spark.queue.push({ kind: 'ok' })
    const res = await callWorker(e, `/api/admin/databases/${id}`, {
      ...postJson(
        { connection_url: `https://${HOST}/spark/`, platform_token: 'new-platform', app_token: 'new-app' },
        { headers: await adminHeaders(e) }
      ),
      method: 'PATCH',
    })
    expect(res.status).toBe(200)
    // Re-saving re-proves the connection in the admin's own session, and the session stays out of the
    // sealed payload (it belongs to the request, not to the registration)
    expect(spark.calls).toEqual([{ url: `${URL}/spark`, platform: 'new-platform', app: 'new-app', session: 'a1' }])
    const sealed = (await listRows(e))[0]!.connection_secret as string
    expect(JSON.parse(await openSecret(e, sealed))).toEqual({
      url: `${URL}/spark`,
      platform_token: 'new-platform',
      app_token: 'new-app',
    })
  })

  it('keeps the stored payload when the new registration fails its test', async () => {
    const e = env()
    const id = await seed(e)
    const before = (await listRows(e))[0]!.connection_secret
    spark.queue.push({ kind: 'fail', message: 'Access denied', code: 'spark_publish_token', errorKind: 'auth' })
    const res = await callWorker(e, `/api/admin/databases/${id}`, {
      ...postJson(body({ app_token: 'other' }), { headers: await adminHeaders(e) }),
      method: 'PATCH',
    })
    expect(res.status).toBe(400)
    expect((await listRows(e))[0]!.connection_secret).toBe(before)
  })

  it('renames a spark row without asking for the tokens again', async () => {
    const e = env()
    const id = await seed(e)
    const res = await callWorker(e, `/api/admin/databases/${id}`, {
      ...postJson({ name: 'Renamed' }, { headers: await adminHeaders(e) }),
      method: 'PATCH',
    })
    expect(res.status).toBe(200)
    expect((await listRows(e))[0]!.name).toBe('Renamed')
    expect(spark.calls).toEqual([])
  })

  it('refuses a Cloudflare link on a spark row', async () => {
    const e = env()
    const id = await seed(e)
    const res = await callWorker(e, `/api/admin/databases/${id}`, {
      ...postJson({ cf_database_id: '22222222-2222-4222-8222-222222222222' }, { headers: await adminHeaders(e) }),
      method: 'PATCH',
    })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toContain('A SparkSQL database')
  })
})
