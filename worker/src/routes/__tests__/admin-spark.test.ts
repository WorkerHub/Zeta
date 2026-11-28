import { afterEach, describe, expect, it, vi } from 'vitest'
import { getMigrations } from '../../lib/migrations'
import { openSecret, sealSecret } from '../../lib/secrets'
import { sparkSessionKey } from '../../lib/spark-profile'
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
    // the admin's own default-config session rides along
    expect(spark.calls).toEqual([
      { url: URL, platform: PLATFORM, app: APP, session: await sparkSessionKey('a1', null) },
    ])
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
    expect(json.results[0]).toMatchObject({
      kind: 'spark',
      has_connection: true,
      has_spark_ui: false,
      has_livy: false,
      is_app_db: false,
    })
  })

  it('reports has_spark_ui: true when registered with ui_url and ui_platform_token, without echoing them', async () => {
    const e = env()
    spark.queue.push({ kind: 'ok' })
    const uiUrl = 'https://spark-ui-4040.publish.example.dev'
    const uiToken = 'spark-ui-token-secret'
    const createRes = await callWorker(
      e,
      '/api/admin/databases',
      postJson(body({ ui_url: uiUrl, ui_platform_token: uiToken }), { headers: await adminHeaders(e) })
    )
    expect(createRes.status).toBe(201)

    const res = await callWorker(e, '/api/admin/databases', { headers: await adminHeaders(e) })
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).not.toContain(uiUrl)
    expect(text).not.toContain(uiToken)
    const json = JSON.parse(text) as { results: Array<Record<string, unknown>> }
    expect(json.results[0]).toMatchObject({ kind: 'spark', has_connection: true, has_spark_ui: true })
  })

  it('reports has_livy: true when livy fields are configured, and never returns them in clear', async () => {
    const e = env()
    spark.queue.push({ kind: 'ok' })
    const livyUrl = 'https://livy-dev.example.com'
    const livyToken = 'livy-secret-token'
    await callWorker(
      e,
      '/api/admin/databases',
      postJson(body({ livy_url: livyUrl, livy_platform_token: livyToken }), { headers: await adminHeaders(e) })
    )

    const adminRes = await callWorker(e, '/api/admin/databases', { headers: await adminHeaders(e) })
    expect(adminRes.status).toBe(200)
    const adminJson = (await adminRes.json()) as { results: Array<Record<string, unknown>> }
    expect(adminJson.results[0]).toMatchObject({ kind: 'spark', has_connection: true, has_livy: true })
    expect(JSON.stringify(adminJson)).not.toContain(livyToken)
    expect(JSON.stringify(adminJson)).not.toContain(livyUrl)

    // Member endpoint also has has_livy: true and no clear credentials
    await e.DB.prepare(
      `INSERT INTO user_database_permissions (id, user_id, database_id, permission, granted_at)
       VALUES ('p1', 'u1', ?1, 'read', 0)`
    )
      .bind(adminJson.results[0]!.id)
      .run()

    const memberRes = await callWorker(e, '/api/databases', { headers: await bearer(e, 'u1', 'member') })
    expect(memberRes.status).toBe(200)
    const memberJson = (await memberRes.json()) as Array<Record<string, unknown>>
    expect(memberJson[0]).toMatchObject({ kind: 'spark', has_livy: true })
    expect(JSON.stringify(memberJson)).not.toContain(livyToken)
    expect(JSON.stringify(memberJson)).not.toContain(livyUrl)
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
    expect(spark.calls).toEqual([
      { url: `${URL}/spark`, platform: 'new-platform', app: 'new-app', session: await sparkSessionKey('a1', null) },
    ])
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

  it('allows updating Spark UI fields via PATCH on a spark row and reflects in has_spark_ui', async () => {
    const e = env()
    const id = await seed(e)
    const uiUrl = 'https://spark-ui-4040.publish.example.dev'
    const uiToken = 'spark-ui-token-secret'

    // Add Spark UI fields
    const patchRes = await callWorker(e, `/api/admin/databases/${id}`, {
      ...postJson({ ui_url: uiUrl, ui_platform_token: uiToken }, { headers: await adminHeaders(e) }),
      method: 'PATCH',
    })
    expect(patchRes.status).toBe(200)
    const patchJson = (await patchRes.json()) as { database: Record<string, unknown> }
    expect(patchJson.database).toMatchObject({ has_spark_ui: true })

    // Stored secret includes the UI fields
    const row = (await listRows(e))[0]!
    const unsealed = JSON.parse(await openSecret(e, row.connection_secret as string)) as Record<string, unknown>
    expect(unsealed.ui_url).toBe(uiUrl)
    expect(unsealed.ui_platform_token).toBe(uiToken)

    // Re-clearing Spark UI fields
    const clearRes = await callWorker(e, `/api/admin/databases/${id}`, {
      ...postJson({ ui_url: '', ui_platform_token: '' }, { headers: await adminHeaders(e) }),
      method: 'PATCH',
    })
    expect(clearRes.status).toBe(200)
    const clearJson = (await clearRes.json()) as { database: Record<string, unknown> }
    expect(clearJson.database).toMatchObject({ has_spark_ui: false })
  })

  it('refuses invalid or unpaired Spark UI fields on PATCH', async () => {
    const e = env()
    const id = await seed(e)
    const res = await callWorker(e, `/api/admin/databases/${id}`, {
      ...postJson({ ui_url: 'https://spark-ui.dev' }, { headers: await adminHeaders(e) }),
      method: 'PATCH',
    })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toContain('both be provided or both omitted')
  })

  it('updates Livy fields on an existing spark row without re-testing or re-entering connection_url', async () => {
    const e = env()
    const id = await seed(e)
    const res = await callWorker(e, `/api/admin/databases/${id}`, {
      ...postJson(
        { livy_url: 'https://livy-target.example.dev', livy_platform_token: 'livy-tok-123' },
        { headers: await adminHeaders(e) }
      ),
      method: 'PATCH',
    })
    expect(res.status).toBe(200)
    const json = (await res.json()) as { database: Record<string, unknown> }
    expect(json.database).toMatchObject({ has_livy: true })
    expect(spark.calls).toEqual([]) // Did not invoke Spark health check

    const sealed = (await listRows(e))[0]!.connection_secret as string
    expect(JSON.parse(await openSecret(e, sealed))).toMatchObject({
      url: URL,
      platform_token: PLATFORM,
      app_token: APP,
      livy_url: 'https://livy-target.example.dev',
      livy_platform_token: 'livy-tok-123',
    })
  })

  it('clears Livy fields when both are set to empty string', async () => {
    const e = env()
    const sealed = await sealSecret(
      e,
      JSON.stringify({
        url: URL,
        platform_token: PLATFORM,
        app_token: APP,
        livy_url: 'https://livy.example.dev',
        livy_platform_token: 'tok',
      })
    )
    await e.DB.prepare(
      `INSERT INTO d1_databases (id, name, binding_name, cf_database_id, kind, connection_secret, is_active, created_at)
       VALUES ('sp2', 'spark2', 'spark:sp2', NULL, 'spark', ?1, 1, 0)`
    )
      .bind(sealed)
      .run()

    const res = await callWorker(e, '/api/admin/databases/sp2', {
      ...postJson({ livy_url: '', livy_platform_token: '' }, { headers: await adminHeaders(e) }),
      method: 'PATCH',
    })
    expect(res.status).toBe(200)
    const json = (await res.json()) as { database: Record<string, unknown> }
    expect(json.database).toMatchObject({ has_livy: false })

    const unsealed = JSON.parse(await openSecret(e, (await listRows(e))[0]!.connection_secret as string))
    expect(unsealed.livy_url).toBeUndefined()
    expect(unsealed.livy_platform_token).toBeUndefined()
  })

  it('rejects unpaired Livy fields in PATCH with 400', async () => {
    const e = env()
    const id = await seed(e)
    const res = await callWorker(e, `/api/admin/databases/${id}`, {
      ...postJson({ livy_url: 'https://livy.example.dev' }, { headers: await adminHeaders(e) }),
      method: 'PATCH',
    })
    expect(res.status).toBe(400)
  })

  it('rejects Livy fields on POST for non-spark targets with 400', async () => {
    const e = env()
    const res = await callWorker(
      e,
      '/api/admin/databases',
      postJson(
        {
          kind: 'postgres',
          name: 'pg-test',
          connection_url: 'postgres://u:p@localhost:5432/db',
          livy_url: 'https://livy.example.dev',
          livy_platform_token: 'tok',
        },
        { headers: await adminHeaders(e) }
      )
    )
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toContain(
      'Livy configuration is only available for Spark databases'
    )
  })

  it('rejects Livy fields on PATCH for non-spark targets with 400', async () => {
    const e = env()
    await e.DB.prepare(
      `INSERT INTO d1_databases (id, name, binding_name, cf_database_id, kind, connection_secret, is_active, created_at)
       VALUES ('pg1', 'pg-test', 'pg:pg1', NULL, 'postgres', NULL, 1, 0)`
    ).run()
    const res = await callWorker(e, '/api/admin/databases/pg1', {
      ...postJson(
        { livy_url: 'https://livy.example.dev', livy_platform_token: 'tok' },
        { headers: await adminHeaders(e) }
      ),
      method: 'PATCH',
    })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toContain(
      'Livy configuration is only available for Spark databases'
    )
  })
})

describe('DELETE /api/admin/databases/:id', () => {
  it('cleans up livy_batches rows when a database is deleted', async () => {
    const e = env()
    await e.DB.prepare(
      `INSERT INTO d1_databases (id, name, binding_name, cf_database_id, kind, connection_secret, is_active, created_at)
       VALUES ('sp1', 'Spark 1', 'spark:sp1', NULL, 'spark', NULL, 1, 0),
              ('sp2', 'Spark 2', 'spark:sp2', NULL, 'spark', NULL, 1, 0)`
    ).run()

    await e.DB.prepare(
      `INSERT INTO livy_batches (id, database_id, batch_id, user_id, file, class_name, created_at)
       VALUES ('b1', 'sp1', 1, 'u1', 'hdfs:///app1.jar', NULL, 1000),
              ('b2', 'sp1', 2, 'u1', 'hdfs:///app2.jar', NULL, 2000),
              ('b3', 'sp2', 1, 'u1', 'hdfs:///app3.jar', NULL, 3000)`
    ).run()

    const res = await callWorker(e, '/api/admin/databases/sp1', {
      method: 'DELETE',
      headers: await adminHeaders(e),
    })
    expect(res.status).toBe(200)

    const sp1Batches = await e.DB.prepare('SELECT * FROM livy_batches WHERE database_id = ?1').bind('sp1').all()
    expect(sp1Batches.results).toHaveLength(0)

    const sp2Batches = await e.DB.prepare('SELECT * FROM livy_batches WHERE database_id = ?1').bind('sp2').all()
    expect(sp2Batches.results).toHaveLength(1)
  })
})
