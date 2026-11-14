import { afterEach, describe, expect, it, vi } from 'vitest'
import { getMigrations } from '../../lib/migrations'
import { sealSecret } from '../../lib/secrets'
import type { Permission } from '../../lib/sql-guard'
import type { Env } from '../../types'
import { bearer, callWorker, fakeEnv } from './fakes'
import { sqliteD1 } from './sqlite-d1'

// The three Spark instance-config routes: permission (admin / exact manage), the expected-config
// round trip through spark_instance_configs, the service status/jars pass-through, the degrade to
// "unknown" when the service is unreachable, and apply's 202/400/502 mapping.

const sparkAdmin = vi.hoisted(() => ({
  status: null as null | {
    state: 'running' | 'draining' | 'restarting' | 'failed_fallback'
    epoch: number
    inflight: number
    effective: { entries: Record<string, string>; jars: string[] }
    lastError: string | null
  },
  serverJars: null as null | Array<{ name: string; sizeBytes: number }>,
  apply: null as
    | null
    | { state: 'draining' | 'restarting' }
    | { error: { message: string; kind: 'sql' | 'transport' } },
  applyCalls: [] as Array<{ url: string; body: unknown }>,
}))

vi.mock('../../lib/spark-executor', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/spark-executor')>()
  return {
    ...actual,
    fetchSparkConfigStatus: async () => sparkAdmin.status,
    fetchSparkJars: async () => sparkAdmin.serverJars,
    applySparkConfig: async (access: { url: string }, body: unknown) => {
      sparkAdmin.applyCalls.push({ url: access.url, body })
      const next = sparkAdmin.apply
      if (next && 'error' in next) {
        throw new actual.SparkQueryError(
          next.error.message,
          next.error.kind,
          next.error.kind === 'sql' ? 'spark_sql' : 'spark_transport'
        )
      }
      return next?.state ?? 'restarting'
    },
  }
})

const HOST = 'spark-3f9a.publish.example.dev'
const PAYLOAD = {
  url: `https://${HOST}`,
  platform_token: 'platform-token',
  app_token: 'app-token',
}

afterEach(() => {
  sparkAdmin.status = null
  sparkAdmin.serverJars = null
  sparkAdmin.apply = null
  sparkAdmin.applyCalls.length = 0
})

// Seeded with an admin (a1), a member (u1, optional permission row), a Spark target (sp1) and a
// non-Spark target (pg1) so the kind and permission guards run for real.
async function envWith(permission: Permission | null): Promise<{ env: Env; app: ReturnType<typeof sqliteD1> }> {
  const app = sqliteD1()
  for (const migration of getMigrations({ TABLE_PREFIX: '' })) app.sqlite.exec(migration.sql)
  const env = fakeEnv({ DB: app.db })
  const sealed = await sealSecret(env, JSON.stringify(PAYLOAD))
  app.sqlite.exec(`
    INSERT INTO users (id, email, name, role, created_at, updated_at)
      VALUES ('u1', 'member@example.com', 'Member', 'member', 0, 0),
             ('a1', 'admin@example.com', 'Admin', 'admin', 0, 0);
    INSERT INTO d1_databases (id, name, binding_name, cf_database_id, kind, connection_secret, is_active, created_at)
      VALUES ('sp1', 'spark', 'spark:sp1', NULL, 'spark', '${sealed}', 1, 0),
             ('pg1', 'postgres', 'pg:pg1', NULL, 'postgres', NULL, 1, 0);
  `)
  if (permission) {
    app.sqlite.exec(
      `INSERT INTO user_database_permissions (id, user_id, database_id, permission, granted_at)
       VALUES ('p1', 'u1', 'sp1', '${permission}', 0)`
    )
  }
  return { env, app }
}

const get = async (env: Env, db: string, as: [string, 'admin' | 'member']) =>
  callWorker(env, `/api/databases/${db}/spark-instance-config`, { headers: await bearer(env, as[0], as[1]) })

const put = async (env: Env, db: string, body: unknown, as: [string, 'admin' | 'member']) =>
  callWorker(env, `/api/databases/${db}/spark-instance-config`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...(await bearer(env, as[0], as[1])) },
    body: JSON.stringify(body),
  })

const apply = async (env: Env, db: string, as: [string, 'admin' | 'member']) =>
  callWorker(env, `/api/databases/${db}/spark-instance-config/apply`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await bearer(env, as[0], as[1])) },
    body: '{}',
  })

const runningStatus = {
  state: 'running' as const,
  epoch: 3,
  inflight: 0,
  effective: { entries: { 'spark.driver.memory': '4g' }, jars: ['delta.jar'] },
  lastError: null,
}

describe('GET /api/databases/:id/spark-instance-config', () => {
  it('returns the expected config plus the service status and jar listing', async () => {
    const { env } = await envWith(null)
    sparkAdmin.status = runningStatus
    sparkAdmin.serverJars = [{ name: 'delta.jar', sizeBytes: 12345 }]

    const res = await get(env, 'sp1', ['a1', 'admin'])
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      entries: {},
      jars: [],
      status: runningStatus,
      serverJars: [{ name: 'delta.jar', sizeBytes: 12345 }],
    })
  })

  it('degrades to null status/serverJars when the service is unreachable', async () => {
    const { env } = await envWith(null)
    const res = await get(env, 'sp1', ['a1', 'admin'])
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ entries: {}, jars: [], status: null, serverJars: null })
  })

  it('echoes the stored expected config', async () => {
    const { env } = await envWith(null)
    await put(env, 'sp1', { entries: { 'spark.driver.memory': '4g' }, jars: [{ type: 'file', value: 'my-udf.jar' }] }, [
      'a1',
      'admin',
    ])
    const res = await get(env, 'sp1', ['a1', 'admin'])
    expect(await res.json()).toMatchObject({
      entries: { 'spark.driver.memory': '4g' },
      jars: [{ type: 'file', value: 'my-udf.jar' }],
    })
  })

  it('allows a manage member and an admin', async () => {
    const { env } = await envWith('manage')
    sparkAdmin.status = runningStatus
    expect((await get(env, 'sp1', ['u1', 'member'])).status).toBe(200)
    expect((await get(env, 'sp1', ['a1', 'admin'])).status).toBe(200)
  })

  it('refuses a write_drop or read member (exact manage required)', async () => {
    for (const permission of ['write_drop', 'read'] as Permission[]) {
      const { env } = await envWith(permission)
      expect((await get(env, 'sp1', ['u1', 'member'])).status, permission).toBe(403)
    }
    const { env } = await envWith(null)
    expect((await get(env, 'sp1', ['u1', 'member'])).status).toBe(403)
  })

  it('refuses a non-Spark target and a missing database', async () => {
    const { env } = await envWith(null)
    expect((await get(env, 'pg1', ['a1', 'admin'])).status).toBe(400)
    expect((await get(env, 'nope', ['a1', 'admin'])).status).toBe(404)
  })
})

describe('PUT /api/databases/:id/spark-instance-config', () => {
  it('validates and persists the expected config, then echoes it back', async () => {
    const { env, app } = await envWith(null)
    const res = await put(
      env,
      'sp1',
      {
        entries: { 'spark.driver.memory': '4g' },
        jars: [{ type: 'url', value: 'https://x/d.jar', sha256: 'a'.repeat(64) }],
      },
      ['a1', 'admin']
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      entries: { 'spark.driver.memory': '4g' },
      jars: [{ type: 'url', value: 'https://x/d.jar', sha256: 'a'.repeat(64) }],
    })
    const row = app.sqlite
      .prepare('SELECT entries, jars FROM spark_instance_configs WHERE database_id = ?')
      .all('sp1')[0] as { entries: string; jars: string }
    expect(JSON.parse(row.entries)).toEqual({ 'spark.driver.memory': '4g' })
    expect(JSON.parse(row.jars)).toEqual([{ type: 'url', value: 'https://x/d.jar', sha256: 'a'.repeat(64) }])
  })

  it('overwrites an existing row (upsert)', async () => {
    const { env, app } = await envWith(null)
    await put(env, 'sp1', { entries: { 'spark.driver.memory': '4g' }, jars: [] }, ['a1', 'admin'])
    await put(env, 'sp1', { entries: { 'spark.driver.memory': '8g' }, jars: [] }, ['a1', 'admin'])
    const rows = app.sqlite.prepare('SELECT COUNT(*) AS n FROM spark_instance_configs').all() as Array<{ n: number }>
    expect(Number(rows[0]!.n)).toBe(1)
  })

  it('rejects a runtime key and a jar in entries', async () => {
    const { env } = await envWith(null)
    expect(
      (await put(env, 'sp1', { entries: { 'spark.sql.shuffle.partitions': '1000' }, jars: [] }, ['a1', 'admin'])).status
    ).toBe(400)
    expect((await put(env, 'sp1', { entries: { 'spark.jars': 'x' }, jars: [] }, ['a1', 'admin'])).status).toBe(400)
  })

  it('rejects a missing field', async () => {
    const { env } = await envWith(null)
    expect((await put(env, 'sp1', { entries: {} }, ['a1', 'admin'])).status).toBe(400)
  })

  it('refuses a write_drop member', async () => {
    const { env } = await envWith('write_drop')
    expect((await put(env, 'sp1', { entries: {}, jars: [] }, ['u1', 'member'])).status).toBe(403)
  })
})

describe('POST /api/databases/:id/spark-instance-config/apply', () => {
  it('applies the stored config and returns the 202 state', async () => {
    const { env } = await envWith(null)
    await put(env, 'sp1', { entries: { 'spark.driver.memory': '4g' }, jars: [] }, ['a1', 'admin'])
    sparkAdmin.apply = { state: 'draining' }

    const res = await apply(env, 'sp1', ['a1', 'admin'])
    expect(res.status).toBe(202)
    expect(await res.json()).toEqual({ state: 'draining' })
    expect(sparkAdmin.applyCalls).toEqual([
      { url: `https://${HOST}`, body: { entries: { 'spark.driver.memory': '4g' }, jars: [] } },
    ])
  })

  it('applies an empty config when nothing is stored', async () => {
    const { env } = await envWith(null)
    sparkAdmin.apply = { state: 'restarting' }
    expect((await apply(env, 'sp1', ['a1', 'admin'])).status).toBe(202)
    expect(sparkAdmin.applyCalls[0]!.body).toEqual({ entries: {}, jars: [] })
  })

  it('surfaces a service rejection as 400 with its own sentence', async () => {
    const { env } = await envWith(null)
    sparkAdmin.apply = { error: { message: 'jar file not found: my-udf.jar', kind: 'sql' } }
    const res = await apply(env, 'sp1', ['a1', 'admin'])
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toBe('jar file not found: my-udf.jar')
  })

  it('answers 502 when the service is unreachable', async () => {
    const { env } = await envWith(null)
    sparkAdmin.apply = { error: { message: 'unreachable', kind: 'transport' } }
    const res = await apply(env, 'sp1', ['a1', 'admin'])
    expect(res.status).toBe(502)
    expect(((await res.json()) as { error: string }).error).toBe('The Spark service could not be reached.')
  })

  it('refuses a read member', async () => {
    const { env } = await envWith('read')
    expect((await apply(env, 'sp1', ['u1', 'member'])).status).toBe(403)
  })
})

describe('audit trail', () => {
  it('records ip and user agent on the save and apply writes', async () => {
    const { env, app } = await envWith(null)
    sparkAdmin.apply = { state: 'restarting' }
    const headers = {
      ...(await bearer(env, 'a1', 'admin')),
      'Content-Type': 'application/json',
      'cf-connecting-ip': '203.0.113.9',
      'user-agent': 'ZetaTest/1.0',
    }

    await callWorker(env, '/api/databases/sp1/spark-instance-config', {
      method: 'PUT',
      headers,
      body: JSON.stringify({ entries: {}, jars: [] }),
    })
    await callWorker(env, '/api/databases/sp1/spark-instance-config/apply', {
      method: 'POST',
      headers,
      body: '{}',
    })

    const rows = app.sqlite
      .prepare(
        `SELECT action, ip, user_agent FROM audit_logs WHERE action LIKE 'spark_instance_config_%' ORDER BY action`
      )
      .all() as Array<{ action: string; ip: string; user_agent: string }>
    expect(rows).toEqual([
      { action: 'spark_instance_config_apply', ip: '203.0.113.9', user_agent: 'ZetaTest/1.0' },
      { action: 'spark_instance_config_save', ip: '203.0.113.9', user_agent: 'ZetaTest/1.0' },
    ])
  })
})
