import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getMigrations } from '../../lib/migrations'
import { sealSecret } from '../../lib/secrets'
import type { Env } from '../../types'
import { bearer, callWorker, fakeEnv, postJson } from './fakes'
import { sqliteD1 } from './sqlite-d1'

const LIVY_URL = 'https://livy-internal.example.org:8998'
const LIVY_TOKEN = 'livy-secret-platform-token-xyz'
const SPARK_URL = 'https://spark.example.org'
const PLATFORM_TOKEN = 'spark-platform-tok'
const APP_TOKEN = 'spark-app-tok'

interface CapturedFetchCall {
  url: string
  method: string
  headers: Record<string, string>
  body?: unknown
}

const capturedCalls: CapturedFetchCall[] = []
let mockFetchHandler: (url: string, init?: RequestInit) => Promise<Response> | Response = () =>
  new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })

const originalFetch = globalThis.fetch

beforeEach(() => {
  capturedCalls.length = 0
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const headersObj: Record<string, string> = {}
    if (init?.headers) {
      const h = new Headers(init.headers)
      h.forEach((v, k) => {
        headersObj[k.toLowerCase()] = v
      })
    }
    let bodyParsed: unknown
    if (typeof init?.body === 'string') {
      try {
        bodyParsed = JSON.parse(init.body)
      } catch {
        bodyParsed = init.body
      }
    }
    capturedCalls.push({
      url: urlStr,
      method: init?.method ?? 'GET',
      headers: headersObj,
      body: bodyParsed,
    })
    return mockFetchHandler(urlStr, init)
  }) as typeof fetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

async function createTestEnv(): Promise<{ env: Env; sparkDbId: string; noLivyDbId: string; sqliteDbId: string }> {
  const app = sqliteD1()
  for (const migration of getMigrations({ TABLE_PREFIX: '' })) app.sqlite.exec(migration.sql)

  app.sqlite.exec(`
    INSERT INTO users (id, email, name, role, created_at, updated_at)
    VALUES ('a1', 'admin@example.com', 'Admin', 'admin', 0, 0),
           ('u1', 'member@example.com', 'Member', 'member', 0, 0),
           ('u2', 'other@example.com', 'Other', 'member', 0, 0),
           ('u3', 'reader@example.com', 'Reader', 'member', 0, 0);
  `)

  const e = fakeEnv({ DB: app.db })

  const sparkWithLivy = await sealSecret(
    e,
    JSON.stringify({
      url: SPARK_URL,
      platform_token: PLATFORM_TOKEN,
      app_token: APP_TOKEN,
      livy_url: LIVY_URL,
      livy_platform_token: LIVY_TOKEN,
    })
  )
  const sparkWithoutLivy = await sealSecret(
    e,
    JSON.stringify({
      url: SPARK_URL,
      platform_token: PLATFORM_TOKEN,
      app_token: APP_TOKEN,
    })
  )

  app.sqlite.exec(`
    INSERT INTO d1_databases (id, name, binding_name, cf_database_id, kind, connection_secret, is_active, created_at)
    VALUES ('db-spark-livy', 'Spark With Livy', 'spark:db-spark-livy', NULL, 'spark', '${sparkWithLivy}', 1, 0),
           ('db-spark-no-livy', 'Spark No Livy', 'spark:db-spark-no-livy', NULL, 'spark', '${sparkWithoutLivy}', 1, 0),
           ('db-sqlite', 'SQLite DB', 'cf:sqlite-1', '11111111-1111-4111-8111-111111111111', 'sqlite', NULL, 1, 0);

    INSERT INTO user_database_permissions (id, user_id, database_id, permission, granted_at)
    VALUES ('p1', 'u1', 'db-spark-livy', 'write', 0),
           ('p2', 'u1', 'db-spark-no-livy', 'write', 0),
           ('p3', 'u1', 'db-sqlite', 'read', 0),
           ('p4', 'u3', 'db-spark-livy', 'read', 0);
  `)

  return { env: e, sparkDbId: 'db-spark-livy', noLivyDbId: 'db-spark-no-livy', sqliteDbId: 'db-sqlite' }
}

describe('Livy route guards & auth', () => {
  it('rejects unauthenticated requests with 401', async () => {
    const { env, sparkDbId } = await createTestEnv()
    const res = await callWorker(env, `/api/databases/${sparkDbId}/livy/sessions`, { method: 'POST' })
    expect(res.status).toBe(401)
  })

  it('rejects users without database permissions with 403', async () => {
    const { env, sparkDbId } = await createTestEnv()
    const res = await callWorker(env, `/api/databases/${sparkDbId}/livy/sessions`, {
      method: 'POST',
      headers: await bearer(env, 'u2', 'member'), // u2 has no permission
    })
    expect(res.status).toBe(403)
  })

  it('rejects non-existent database with 404', async () => {
    const { env } = await createTestEnv()
    const res = await callWorker(env, '/api/databases/non-existent/livy/sessions', {
      method: 'POST',
      headers: await bearer(env, 'a1', 'admin'),
    })
    expect(res.status).toBe(404)
  })

  it('rejects non-Spark database with 400', async () => {
    const { env, sqliteDbId } = await createTestEnv()
    const res = await callWorker(env, `/api/databases/${sqliteDbId}/livy/sessions`, {
      method: 'POST',
      headers: await bearer(env, 'u1', 'member'),
    })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toContain('only available for Spark databases')
  })

  it('rejects Spark database without Livy configured with 400', async () => {
    const { env, noLivyDbId } = await createTestEnv()
    const res = await callWorker(env, `/api/databases/${noLivyDbId}/livy/sessions`, {
      method: 'POST',
      headers: await bearer(env, 'u1', 'member'),
    })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toContain('not configured')
  })

  it('rejects read-only users with 403 on write-class operations (blocking-1)', async () => {
    const { env, sparkDbId } = await createTestEnv()
    const readerHeaders = await bearer(env, 'u3', 'member')

    // POST /sessions requires >= write
    const postSession = await callWorker(
      env,
      `/api/databases/${sparkDbId}/livy/sessions`,
      postJson({ kind: 'spark' }, { headers: readerHeaders })
    )
    expect(postSession.status).toBe(403)
    expect(((await postSession.json()) as { error: string }).error).toBe('Access denied')

    // DELETE /sessions/:sessionId requires >= write
    const delSession = await callWorker(env, `/api/databases/${sparkDbId}/livy/sessions/1`, {
      method: 'DELETE',
      headers: readerHeaders,
    })
    expect(delSession.status).toBe(403)
    expect(((await delSession.json()) as { error: string }).error).toBe('Access denied')

    // POST /sessions/:sessionId/statements requires >= write
    const postStatement = await callWorker(
      env,
      `/api/databases/${sparkDbId}/livy/sessions/1/statements`,
      postJson({ code: '1 + 1' }, { headers: readerHeaders })
    )
    expect(postStatement.status).toBe(403)
    expect(((await postStatement.json()) as { error: string }).error).toBe('Access denied')

    // POST /batches requires >= write
    const postBatch = await callWorker(
      env,
      `/api/databases/${sparkDbId}/livy/batches`,
      postJson({ file: 'hdfs:///app.jar' }, { headers: readerHeaders })
    )
    expect(postBatch.status).toBe(403)
    expect(((await postBatch.json()) as { error: string }).error).toBe('Access denied')
  })

  it('allows read-only users on read-class operations (blocking-1)', async () => {
    const { env, sparkDbId } = await createTestEnv()
    const readerHeaders = await bearer(env, 'u3', 'member')

    mockFetchHandler = (url) => {
      if (url === `${LIVY_URL}/sessions/1`) {
        return new Response(JSON.stringify({ id: 1, state: 'idle' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      if (url === `${LIVY_URL}/sessions/1/statements/10`) {
        return new Response(JSON.stringify({ id: 10, state: 'available', output: { status: 'ok' } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return new Response('{}', { status: 404, headers: { 'Content-Type': 'application/json' } })
    }

    // GET /sessions/:sessionId
    const getSession = await callWorker(env, `/api/databases/${sparkDbId}/livy/sessions/1`, {
      headers: readerHeaders,
    })
    expect(getSession.status).toBe(200)

    // GET /sessions/:sessionId/statements/:statementId
    const getStatement = await callWorker(env, `/api/databases/${sparkDbId}/livy/sessions/1/statements/10`, {
      headers: readerHeaders,
    })
    expect(getStatement.status).toBe(200)

    // GET /batches
    const getBatches = await callWorker(env, `/api/databases/${sparkDbId}/livy/batches`, {
      headers: readerHeaders,
    })
    expect(getBatches.status).toBe(200)
  })

  it('allows admin on write-class operations without explicit user_database_permissions', async () => {
    const { env, sparkDbId } = await createTestEnv()
    const adminHeaders = await bearer(env, 'a1', 'admin')

    mockFetchHandler = (url) => {
      if (url === `${LIVY_URL}/sessions`) {
        return new Response(JSON.stringify({ id: 99, state: 'starting' }), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return new Response('{}', { status: 404, headers: { 'Content-Type': 'application/json' } })
    }

    const res = await callWorker(
      env,
      `/api/databases/${sparkDbId}/livy/sessions`,
      postJson({ kind: 'spark' }, { headers: adminHeaders })
    )
    expect(res.status).toBe(201)
  })
})

describe('Livy Sessions API', () => {
  it('POST /sessions forwards request with fixed metastore conf and bearer token', async () => {
    const { env, sparkDbId } = await createTestEnv()
    mockFetchHandler = (url) => {
      if (url === `${LIVY_URL}/sessions`) {
        return new Response(
          JSON.stringify({ id: 1, state: 'starting', kind: 'spark', appId: null, log: ['log line 1'] }),
          { status: 201, headers: { 'Content-Type': 'application/json' } }
        )
      }
      return new Response('Not found', { status: 404 })
    }

    const res = await callWorker(
      env,
      `/api/databases/${sparkDbId}/livy/sessions`,
      postJson({ kind: 'pyspark' }, { headers: await bearer(env, 'u1', 'member') })
    )

    expect(res.status).toBe(201)
    const json = await res.json()
    expect(json).toMatchObject({ id: 1, state: 'starting', kind: 'spark' })

    expect(capturedCalls).toHaveLength(1)
    const call = capturedCalls[0]!
    expect(call.url).toBe(`${LIVY_URL}/sessions`)
    expect(call.method).toBe('POST')
    expect(call.headers.authorization).toBe(`Bearer ${LIVY_TOKEN}`)
    expect(call.body).toEqual({
      kind: 'pyspark',
      conf: {
        'spark.hadoop.hive.metastore.schema.verification': 'false',
      },
    })
  })

  it('POST /sessions validates kind against whitelist (spark|pyspark|sql) returning 400 on invalid kind', async () => {
    const { env, sparkDbId } = await createTestEnv()
    const res = await callWorker(
      env,
      `/api/databases/${sparkDbId}/livy/sessions`,
      postJson({ kind: 'python' }, { headers: await bearer(env, 'u1', 'member') })
    )
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toContain('Invalid kind')
  })

  it('GET /sessions/:sessionId returns session status or 404', async () => {
    const { env, sparkDbId } = await createTestEnv()
    mockFetchHandler = (url) => {
      if (url === `${LIVY_URL}/sessions/1`) {
        return new Response(JSON.stringify({ id: 1, state: 'idle', kind: 'spark', appId: 'app-001', log: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return new Response('{}', { status: 404, headers: { 'Content-Type': 'application/json' } })
    }

    const okRes = await callWorker(env, `/api/databases/${sparkDbId}/livy/sessions/1`, {
      headers: await bearer(env, 'u1', 'member'),
    })
    expect(okRes.status).toBe(200)
    expect(await okRes.json()).toMatchObject({ id: 1, state: 'idle', appId: 'app-001' })

    const notFoundRes = await callWorker(env, `/api/databases/${sparkDbId}/livy/sessions/999`, {
      headers: await bearer(env, 'u1', 'member'),
    })
    expect(notFoundRes.status).toBe(404)
    expect(await notFoundRes.json()).toMatchObject({ error: 'Session not found' })
  })

  it('DELETE /sessions/:sessionId deletes session or returns 404', async () => {
    const { env, sparkDbId } = await createTestEnv()
    mockFetchHandler = (url, init) => {
      if (url === `${LIVY_URL}/sessions/1` && init?.method === 'DELETE') {
        return new Response(JSON.stringify({ msg: 'deleted' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return new Response('{}', { status: 404, headers: { 'Content-Type': 'application/json' } })
    }

    const okRes = await callWorker(env, `/api/databases/${sparkDbId}/livy/sessions/1`, {
      method: 'DELETE',
      headers: await bearer(env, 'u1', 'member'),
    })
    expect(okRes.status).toBe(200)
    expect(await okRes.json()).toMatchObject({ message: 'Deleted' })

    const notFoundRes = await callWorker(env, `/api/databases/${sparkDbId}/livy/sessions/999`, {
      method: 'DELETE',
      headers: await bearer(env, 'u1', 'member'),
    })
    expect(notFoundRes.status).toBe(404)
  })
})

describe('Livy Statements API', () => {
  it('POST /sessions/:sessionId/statements validates code and forwards execution', async () => {
    const { env, sparkDbId } = await createTestEnv()
    mockFetchHandler = (url) => {
      if (url === `${LIVY_URL}/sessions/1/statements`) {
        return new Response(JSON.stringify({ id: 10, code: '1 + 1', state: 'running', output: null, progress: 0 }), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return new Response('{}', { status: 404, headers: { 'Content-Type': 'application/json' } })
    }

    // Missing code
    const badRes = await callWorker(
      env,
      `/api/databases/${sparkDbId}/livy/sessions/1/statements`,
      postJson({}, { headers: await bearer(env, 'u1', 'member') })
    )
    expect(badRes.status).toBe(400)

    // Invalid kind
    const badKindRes = await callWorker(
      env,
      `/api/databases/${sparkDbId}/livy/sessions/1/statements`,
      postJson({ code: 'val x = 1', kind: 'scala' }, { headers: await bearer(env, 'u1', 'member') })
    )
    expect(badKindRes.status).toBe(400)
    expect(((await badKindRes.json()) as { error: string }).error).toContain('Invalid kind')

    // Valid code
    const okRes = await callWorker(
      env,
      `/api/databases/${sparkDbId}/livy/sessions/1/statements`,
      postJson({ code: '1 + 1' }, { headers: await bearer(env, 'u1', 'member') })
    )
    expect(okRes.status).toBe(201)
    expect(await okRes.json()).toMatchObject({ id: 10, state: 'running' })
    expect(capturedCalls[capturedCalls.length - 1]!.body).toEqual({ code: '1 + 1' })
  })

  it('GET /sessions/:sessionId/statements/:statementId returns statement status and output', async () => {
    const { env, sparkDbId } = await createTestEnv()
    mockFetchHandler = (url) => {
      if (url === `${LIVY_URL}/sessions/1/statements/10`) {
        return new Response(
          JSON.stringify({
            id: 10,
            code: '1 + 1',
            state: 'available',
            output: { status: 'ok', execution_count: 1, data: { 'text/plain': '2' } },
            progress: 1,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      }
      return new Response('{}', { status: 404, headers: { 'Content-Type': 'application/json' } })
    }

    const res = await callWorker(env, `/api/databases/${sparkDbId}/livy/sessions/1/statements/10`, {
      headers: await bearer(env, 'u1', 'member'),
    })
    expect(res.status).toBe(200)
    const json = (await res.json()) as { state: string; output: { status: string; data: Record<string, string> } }
    expect(json.state).toBe('available')
    expect(json.output.data['text/plain']).toBe('2')
  })
})

describe('Livy Batches API', () => {
  it('POST /batches validates file, injects fixed conf, and records to livy_batches table', async () => {
    const { env, sparkDbId } = await createTestEnv()
    mockFetchHandler = (url) => {
      if (url === `${LIVY_URL}/batches`) {
        return new Response(JSON.stringify({ id: 42, state: 'starting', appId: 'app-batch-42', log: [] }), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return new Response('{}', { status: 404, headers: { 'Content-Type': 'application/json' } })
    }

    // Missing file
    const badRes = await callWorker(
      env,
      `/api/databases/${sparkDbId}/livy/batches`,
      postJson({ className: 'Main' }, { headers: await bearer(env, 'u1', 'member') })
    )
    expect(badRes.status).toBe(400)

    // Valid batch submit
    const res = await callWorker(
      env,
      `/api/databases/${sparkDbId}/livy/batches`,
      postJson(
        { file: 'hdfs:///apps/analytics.jar', className: 'org.example.Analytics', args: ['--date', '2026-11-28'] },
        { headers: await bearer(env, 'u1', 'member') }
      )
    )
    expect(res.status).toBe(201)
    const json = (await res.json()) as Record<string, unknown>
    expect(json).toMatchObject({
      batch_id: 42,
      file: 'hdfs:///apps/analytics.jar',
      class_name: 'org.example.Analytics',
      state: 'starting',
      appId: 'app-batch-42',
    })
    expect(typeof json.id).toBe('string')
    expect(typeof json.created_at).toBe('number')

    // Verify Livy request payload had fixed hive metastore verification conf
    const call = capturedCalls[capturedCalls.length - 1]!
    expect(call.body).toEqual({
      file: 'hdfs:///apps/analytics.jar',
      className: 'org.example.Analytics',
      args: ['--date', '2026-11-28'],
      conf: {
        'spark.hadoop.hive.metastore.schema.verification': 'false',
      },
    })

    // Verify database row was inserted into livy_batches
    const rows = await env.DB.prepare('SELECT * FROM livy_batches WHERE batch_id = 42').all<Record<string, unknown>>()
    expect(rows.results).toHaveLength(1)
    expect(rows.results[0]).toMatchObject({
      batch_id: 42,
      database_id: sparkDbId,
      user_id: 'u1',
      file: 'hdfs:///apps/analytics.jar',
      class_name: 'org.example.Analytics',
    })
  })

  it('GET /batches lists jobs from table with live status queried from Livy', async () => {
    const { env, sparkDbId } = await createTestEnv()
    // Seed 2 batches for u1
    await env.DB.prepare(`
      INSERT INTO livy_batches (id, database_id, batch_id, user_id, file, class_name, created_at)
      VALUES ('b1', ?1, 101, 'u1', 'hdfs:///app1.jar', 'App1', 100),
             ('b2', ?1, 102, 'u1', 'hdfs:///app2.jar', NULL, 200)
    `)
      .bind(sparkDbId)
      .run()

    mockFetchHandler = (url) => {
      if (url === `${LIVY_URL}/batches/102`) {
        return new Response(JSON.stringify({ id: 102, state: 'success', appId: 'app-102' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      if (url === `${LIVY_URL}/batches/101`) {
        // 101 was pruned by Livy
        return new Response('Session 101 not found', { status: 404, headers: { 'Content-Type': 'text/plain' } })
      }
      return new Response('{}', { status: 404, headers: { 'Content-Type': 'application/json' } })
    }

    const res = await callWorker(env, `/api/databases/${sparkDbId}/livy/batches`, {
      headers: await bearer(env, 'u1', 'member'),
    })
    expect(res.status).toBe(200)
    const json = (await res.json()) as { results: Array<Record<string, unknown>> }
    expect(json.results).toHaveLength(2)

    // Newer job first (ORDER BY created_at DESC)
    expect(json.results[0]).toMatchObject({
      batch_id: 102,
      file: 'hdfs:///app2.jar',
      state: 'success',
      appId: 'app-102',
    })

    // Expired job gracefully degrades to 'unknown'
    expect(json.results[1]).toMatchObject({
      batch_id: 101,
      file: 'hdfs:///app1.jar',
      state: 'unknown',
      appId: null,
    })
  })

  it('GET /batches/:batchId and GET /batches/:batchId/log forward to Livy', async () => {
    const { env, sparkDbId } = await createTestEnv()
    // Seed batch 42 for u1
    await env.DB.prepare(`
      INSERT INTO livy_batches (id, database_id, batch_id, user_id, file, class_name, created_at)
      VALUES ('b42', ?1, 42, 'u1', 'hdfs:///app42.jar', NULL, 100)
    `)
      .bind(sparkDbId)
      .run()

    mockFetchHandler = (url) => {
      if (url === `${LIVY_URL}/batches/42`) {
        return new Response(JSON.stringify({ id: 42, state: 'running', appId: 'app-42', log: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      if (url === `${LIVY_URL}/batches/42/log?from=10&size=50`) {
        return new Response(JSON.stringify({ id: 42, from: 10, size: 2, total: 100, log: ['line 10', 'line 11'] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return new Response('{}', { status: 404, headers: { 'Content-Type': 'application/json' } })
    }

    const batchRes = await callWorker(env, `/api/databases/${sparkDbId}/livy/batches/42`, {
      headers: await bearer(env, 'u1', 'member'),
    })
    expect(batchRes.status).toBe(200)
    expect(await batchRes.json()).toMatchObject({ id: 42, state: 'running' })

    const logRes = await callWorker(env, `/api/databases/${sparkDbId}/livy/batches/42/log?from=10&size=50`, {
      headers: await bearer(env, 'u1', 'member'),
    })
    expect(logRes.status).toBe(200)
    expect(await logRes.json()).toMatchObject({ id: 42, from: 10, log: ['line 10', 'line 11'] })
  })

  it('enforces batch ownership on GET /batches/:batchId and GET /batches/:batchId/log (S1 IDOR defense)', async () => {
    const { env, sparkDbId } = await createTestEnv()
    // Batch 42 belongs to u1
    await env.DB.prepare(`
      INSERT INTO livy_batches (id, database_id, batch_id, user_id, file, class_name, created_at)
      VALUES ('b42', ?1, 42, 'u1', 'hdfs:///app42.jar', NULL, 100)
    `)
      .bind(sparkDbId)
      .run()

    // Grant u2 read permission to the database
    await env.DB.prepare(`
      INSERT INTO user_database_permissions (id, user_id, database_id, permission, granted_at)
      VALUES ('perm-u2', 'u2', ?1, 'read', 0)
    `)
      .bind(sparkDbId)
      .run()

    // u2 tries to query u1's batch details or logs -> 404, upstream never called
    const u2DetailRes = await callWorker(env, `/api/databases/${sparkDbId}/livy/batches/42`, {
      headers: await bearer(env, 'u2', 'member'),
    })
    expect(u2DetailRes.status).toBe(404)
    expect(((await u2DetailRes.json()) as { error: string }).error).toBe('Batch not found')

    const u2LogRes = await callWorker(env, `/api/databases/${sparkDbId}/livy/batches/42/log`, {
      headers: await bearer(env, 'u2', 'member'),
    })
    expect(u2LogRes.status).toBe(404)
    expect(((await u2LogRes.json()) as { error: string }).error).toBe('Batch not found')
    expect(capturedCalls).toHaveLength(0)
  })

  it('rejects non-integer batchId with 404 avoiding SQLite affinity coercion (nit-4)', async () => {
    const { env, sparkDbId } = await createTestEnv()
    // Batch 42 belongs to u1
    await env.DB.prepare(`
      INSERT INTO livy_batches (id, database_id, batch_id, user_id, file, class_name, created_at)
      VALUES ('b42', ?1, 42, 'u1', 'hdfs:///app42.jar', NULL, 100)
    `)
      .bind(sparkDbId)
      .run()

    const u1Headers = await bearer(env, 'u1', 'member')

    // '42abc' would be cast by SQLite to 42, but our validation rejects it with 404
    for (const invalidId of ['42abc', 'not-an-int', '3.14', ' ']) {
      const detailRes = await callWorker(
        env,
        `/api/databases/${sparkDbId}/livy/batches/${encodeURIComponent(invalidId)}`,
        {
          headers: u1Headers,
        }
      )
      expect(detailRes.status).toBe(404)
      expect(((await detailRes.json()) as { error: string }).error).toBe('Batch not found')

      const logRes = await callWorker(
        env,
        `/api/databases/${sparkDbId}/livy/batches/${encodeURIComponent(invalidId)}/log`,
        {
          headers: u1Headers,
        }
      )
      expect(logRes.status).toBe(404)
      expect(((await logRes.json()) as { error: string }).error).toBe('Batch not found')
    }
    expect(capturedCalls).toHaveLength(0)
  })

  it('encodes path parameters before forwarding to upstream Livy (N3)', async () => {
    const { env, sparkDbId } = await createTestEnv()
    // Seed batch with id 99 for u1
    await env.DB.prepare(`
      INSERT INTO livy_batches (id, database_id, batch_id, user_id, file, class_name, created_at)
      VALUES ('b99', ?1, 99, 'u1', 'hdfs:///app99.jar', NULL, 100)
    `)
      .bind(sparkDbId)
      .run()

    mockFetchHandler = () => new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })

    await callWorker(env, `/api/databases/${sparkDbId}/livy/sessions/${encodeURIComponent('sess/1')}`, {
      headers: await bearer(env, 'u1', 'member'),
    })
    expect(capturedCalls[capturedCalls.length - 1]!.url).toBe(`${LIVY_URL}/sessions/sess%2F1`)

    await callWorker(
      env,
      `/api/databases/${sparkDbId}/livy/sessions/${encodeURIComponent('sess/1')}/statements/${encodeURIComponent('stmt#2')}`,
      {
        headers: await bearer(env, 'u1', 'member'),
      }
    )
    expect(capturedCalls[capturedCalls.length - 1]!.url).toBe(`${LIVY_URL}/sessions/sess%2F1/statements/stmt%232`)
  })
})

describe('Livy error handling and credential safety', () => {
  it('returns 502 when Livy service is unreachable without leaking credentials or internal URL', async () => {
    const { env, sparkDbId } = await createTestEnv()
    mockFetchHandler = () => {
      throw new TypeError('fetch failed: connect ECONNREFUSED')
    }

    const res = await callWorker(
      env,
      `/api/databases/${sparkDbId}/livy/sessions`,
      postJson({}, { headers: await bearer(env, 'u1', 'member') })
    )
    expect(res.status).toBe(502)
    const text = await res.text()
    expect(text).not.toContain(LIVY_TOKEN)
    expect(text).not.toContain(LIVY_URL)
    expect(text).toContain('The Livy service could not be reached.')
  })

  it('sanitizes and whitelists Livy non-2xx error responses without leaking credentials (nit-5)', async () => {
    const { env, sparkDbId } = await createTestEnv()
    const u1Headers = await bearer(env, 'u1', 'member')

    // Case 1: 500 JSON error leaking internal URL and token
    mockFetchHandler = () =>
      new Response(JSON.stringify({ error: `Connection failed at ${LIVY_URL} with authorization ${LIVY_TOKEN}` }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      })

    const res500 = await callWorker(
      env,
      `/api/databases/${sparkDbId}/livy/sessions`,
      postJson({ kind: 'spark' }, { headers: u1Headers })
    )
    expect(res500.status).toBe(500)
    const json500 = (await res500.json()) as { error: string }
    expect(json500.error).not.toContain(LIVY_URL)
    expect(json500.error).not.toContain(LIVY_TOKEN)
    expect(json500.error).toContain('[redacted]')

    // Case 2: 400 plain text error leaking internal URL and token
    mockFetchHandler = () =>
      new Response(`Exception: Livy refused job from ${LIVY_URL} using token ${LIVY_TOKEN}`, {
        status: 400,
        headers: { 'Content-Type': 'text/plain' },
      })

    const res400 = await callWorker(
      env,
      `/api/databases/${sparkDbId}/livy/batches`,
      postJson({ file: 'hdfs:///app.jar' }, { headers: u1Headers })
    )
    expect(res400.status).toBe(400)
    const json400 = (await res400.json()) as { error: string }
    expect(json400.error).not.toContain(LIVY_URL)
    expect(json400.error).not.toContain(LIVY_TOKEN)
    expect(json400.error).toContain('[redacted]')
  })
})
