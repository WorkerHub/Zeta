import type { Context } from 'hono'
import { Hono } from 'hono'
import { now, tables } from '../lib/db'
import { uuid } from '../lib/id'
import { openSecret } from '../lib/secrets'
import { normalizeSparkAccess } from '../lib/spark-access'
import { requireAuth } from '../middleware/auth'
import type { DatabaseRow, Env, LivyBatchRow, Variables } from '../types'

// ── Livy Forwarding Layer (Sessions / Statements / Batches / Logs) ───────────
// Proxies requests to a Spark Livy 0.8.0 instance using the stored platform token.
// Fixed configuration: spark.hadoop.hive.metastore.schema.verification=false is
// injected into POST /sessions and POST /batches on the server side.
// Credentials and internal URLs are never echoed to clients or logs.

const livy = new Hono<{ Bindings: Env; Variables: Variables }>()
livy.use('*', requireAuth)

type Ctx = Context<{ Bindings: Env; Variables: Variables }>

export const FIXED_LIVY_CONF = {
  'spark.hadoop.hive.metastore.schema.verification': 'false',
}

const ALLOWED_LIVY_KINDS = new Set(['spark', 'pyspark', 'sql'])

interface ResolvedLivyTarget {
  databaseId: string
  livyUrl: string
  livyToken: string
}

async function resolveLivyTarget(c: Ctx, databaseId: string): Promise<ResolvedLivyTarget | Response> {
  const T = tables(c.env)
  const db = await c.env.DB.prepare(`SELECT * FROM ${T.d1_databases} WHERE id = ?1 AND is_active = 1`)
    .bind(databaseId)
    .first<DatabaseRow>()
  if (!db) return c.json({ error: 'Database not found' }, 404)
  if (c.get('userRole') !== 'admin') {
    const perm = await c.env.DB.prepare(
      `SELECT permission FROM ${T.user_database_permissions} WHERE user_id = ?1 AND database_id = ?2`
    )
      .bind(c.get('userId'), databaseId)
      .first<{ permission: string }>()
    if (!perm) return c.json({ error: 'Access denied' }, 403)
  }
  if ((db.kind ?? 'sqlite') !== 'spark') {
    return c.json({ error: 'Livy is only available for Spark databases' }, 400)
  }
  if (!db.connection_secret) {
    return c.json({ error: 'Livy is not configured for this database' }, 400)
  }
  try {
    const unsealed = JSON.parse(await openSecret(c.env, db.connection_secret))
    const access = normalizeSparkAccess(unsealed)
    if (!access.ok || !access.access.livy_url || !access.access.livy_platform_token) {
      return c.json({ error: 'Livy is not configured for this database' }, 400)
    }
    return {
      databaseId,
      livyUrl: access.access.livy_url,
      livyToken: access.access.livy_platform_token,
    }
  } catch {
    return c.json({ error: 'Failed to read database connection' }, 500)
  }
}

interface LivyFetchResult {
  ok: boolean
  status: number
  data: unknown
}

async function livyFetch(
  target: ResolvedLivyTarget,
  path: string,
  options: {
    method?: string
    body?: unknown
  } = {}
): Promise<LivyFetchResult> {
  const url = `${target.livyUrl}${path}`
  const headers: Record<string, string> = {
    Authorization: `Bearer ${target.livyToken}`,
    Accept: 'application/json',
  }
  let bodyStr: string | undefined
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json'
    bodyStr = JSON.stringify(options.body)
  }

  let res: Response
  try {
    res = await fetch(url, {
      method: options.method ?? 'GET',
      headers,
      body: bodyStr,
    })
  } catch (err) {
    console.error(`Livy request failed: ${err instanceof Error ? err.name : typeof err}`)
    return { ok: false, status: 502, data: { error: 'The Livy service could not be reached.' } }
  }

  const contentType = res.headers.get('content-type') ?? ''
  let data: unknown
  if (contentType.includes('application/json')) {
    try {
      data = await res.json()
    } catch {
      data = null
    }
  } else {
    data = await res.text()
  }

  return { ok: res.ok, status: res.status, data }
}

// ── Session management ──────────────────────────────────────────────────────

livy.post('/:id/livy/sessions', async (c) => {
  const target = await resolveLivyTarget(c, c.req.param('id'))
  if (target instanceof Response) return target

  const body = await c.req.json<{ kind?: unknown }>().catch(() => null)
  let kind = 'spark'
  if (body && body.kind !== undefined) {
    if (typeof body.kind !== 'string' || !ALLOWED_LIVY_KINDS.has(body.kind.trim())) {
      return c.json({ error: 'Invalid kind: must be spark, pyspark, or sql' }, 400)
    }
    kind = body.kind.trim()
  }

  const res = await livyFetch(target, '/sessions', {
    method: 'POST',
    body: {
      kind,
      conf: { ...FIXED_LIVY_CONF },
    },
  })

  return c.json(res.data, res.status as 200)
})

livy.get('/:id/livy/sessions/:sessionId', async (c) => {
  const target = await resolveLivyTarget(c, c.req.param('id'))
  if (target instanceof Response) return target

  const sessionId = encodeURIComponent(c.req.param('sessionId'))
  const res = await livyFetch(target, `/sessions/${sessionId}`)
  if (res.status === 404) return c.json({ error: 'Session not found' }, 404)
  return c.json(res.data, res.status as 200)
})

livy.delete('/:id/livy/sessions/:sessionId', async (c) => {
  const target = await resolveLivyTarget(c, c.req.param('id'))
  if (target instanceof Response) return target

  const sessionId = encodeURIComponent(c.req.param('sessionId'))
  const res = await livyFetch(target, `/sessions/${sessionId}`, { method: 'DELETE' })
  if (res.status === 404) return c.json({ error: 'Session not found' }, 404)
  if (res.ok) return c.json({ message: 'Deleted' })
  return c.json(res.data, res.status as 200)
})

// ── Interactive statement execution ─────────────────────────────────────────

livy.post('/:id/livy/sessions/:sessionId/statements', async (c) => {
  const target = await resolveLivyTarget(c, c.req.param('id'))
  if (target instanceof Response) return target

  const body = await c.req.json<{ code?: unknown; kind?: unknown }>().catch(() => null)
  if (!body || typeof body.code !== 'string' || !body.code.trim()) {
    return c.json({ error: 'code is required' }, 400)
  }

  const sessionId = encodeURIComponent(c.req.param('sessionId'))
  const livyPayload: Record<string, unknown> = {
    code: body.code,
  }
  if (body.kind !== undefined) {
    if (typeof body.kind !== 'string' || !ALLOWED_LIVY_KINDS.has(body.kind.trim())) {
      return c.json({ error: 'Invalid kind: must be spark, pyspark, or sql' }, 400)
    }
    livyPayload.kind = body.kind.trim()
  }

  const res = await livyFetch(target, `/sessions/${sessionId}/statements`, {
    method: 'POST',
    body: livyPayload,
  })
  if (res.status === 404) return c.json({ error: 'Session not found' }, 404)
  return c.json(res.data, res.status as 200)
})

livy.get('/:id/livy/sessions/:sessionId/statements/:statementId', async (c) => {
  const target = await resolveLivyTarget(c, c.req.param('id'))
  if (target instanceof Response) return target

  const sessionId = encodeURIComponent(c.req.param('sessionId'))
  const statementId = encodeURIComponent(c.req.param('statementId'))
  const res = await livyFetch(target, `/sessions/${sessionId}/statements/${statementId}`)
  if (res.status === 404) return c.json({ error: 'Statement not found' }, 404)
  return c.json(res.data, res.status as 200)
})

// ── Batch job submission and monitoring ──────────────────────────────────────

livy.post('/:id/livy/batches', async (c) => {
  const target = await resolveLivyTarget(c, c.req.param('id'))
  if (target instanceof Response) return target

  const body = await c.req.json<{ file?: unknown; className?: unknown; args?: unknown }>().catch(() => null)
  if (!body || typeof body.file !== 'string' || !body.file.trim()) {
    return c.json({ error: 'file is required' }, 400)
  }

  const livyPayload: Record<string, unknown> = {
    file: body.file.trim(),
    conf: { ...FIXED_LIVY_CONF },
  }
  let className: string | null = null
  if (typeof body.className === 'string' && body.className.trim()) {
    className = body.className.trim()
    livyPayload.className = className
  }
  if (Array.isArray(body.args)) {
    livyPayload.args = body.args.map(String)
  } else if (typeof body.args === 'string' && body.args.trim()) {
    livyPayload.args = [body.args.trim()]
  }

  const res = await livyFetch(target, '/batches', {
    method: 'POST',
    body: livyPayload,
  })

  if (!res.ok) {
    return c.json(res.data, res.status as 200)
  }

  const livyData = res.data as { id: number; state?: string; appId?: string }
  const batchId = livyData.id
  const recordId = uuid()
  const ts = now()
  const T = tables(c.env)

  await c.env.DB.prepare(
    `INSERT INTO ${T.livy_batches} (id, database_id, batch_id, user_id, file, class_name, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`
  )
    .bind(recordId, target.databaseId, batchId, c.get('userId'), body.file.trim(), className, ts)
    .run()

  return c.json(
    {
      id: recordId,
      batch_id: batchId,
      state: livyData.state ?? 'starting',
      appId: livyData.appId ?? null,
      file: body.file.trim(),
      class_name: className,
      created_at: ts,
    },
    201
  )
})

livy.get('/:id/livy/batches', async (c) => {
  const target = await resolveLivyTarget(c, c.req.param('id'))
  if (target instanceof Response) return target

  const T = tables(c.env)
  const rows = await c.env.DB.prepare(
    `SELECT * FROM ${T.livy_batches} WHERE database_id = ?1 AND user_id = ?2 ORDER BY created_at DESC LIMIT 50`
  )
    .bind(target.databaseId, c.get('userId'))
    .all<LivyBatchRow>()

  const results = await Promise.all(
    rows.results.map(async (row) => {
      const res = await livyFetch(target, `/batches/${encodeURIComponent(String(row.batch_id))}`)
      if (res.ok && res.data && typeof res.data === 'object') {
        const d = res.data as Record<string, unknown>
        return {
          id: row.id,
          batch_id: row.batch_id,
          file: row.file,
          class_name: row.class_name,
          created_at: row.created_at,
          state: typeof d.state === 'string' ? d.state : 'unknown',
          appId: typeof d.appId === 'string' ? d.appId : null,
        }
      }
      return {
        id: row.id,
        batch_id: row.batch_id,
        file: row.file,
        class_name: row.class_name,
        created_at: row.created_at,
        state: 'unknown',
        appId: null,
      }
    })
  )

  return c.json({ results })
})

livy.get('/:id/livy/batches/:batchId', async (c) => {
  const target = await resolveLivyTarget(c, c.req.param('id'))
  if (target instanceof Response) return target

  const rawBatchId = c.req.param('batchId')
  const T = tables(c.env)
  const batchRow = await c.env.DB.prepare(
    `SELECT id FROM ${T.livy_batches} WHERE database_id = ?1 AND user_id = ?2 AND batch_id = ?3`
  )
    .bind(target.databaseId, c.get('userId'), rawBatchId)
    .first()
  if (!batchRow) return c.json({ error: 'Batch not found' }, 404)

  const batchId = encodeURIComponent(rawBatchId)
  const res = await livyFetch(target, `/batches/${batchId}`)
  if (res.status === 404) return c.json({ error: 'Batch not found' }, 404)
  return c.json(res.data, res.status as 200)
})

livy.get('/:id/livy/batches/:batchId/log', async (c) => {
  const target = await resolveLivyTarget(c, c.req.param('id'))
  if (target instanceof Response) return target

  const rawBatchId = c.req.param('batchId')
  const T = tables(c.env)
  const batchRow = await c.env.DB.prepare(
    `SELECT id FROM ${T.livy_batches} WHERE database_id = ?1 AND user_id = ?2 AND batch_id = ?3`
  )
    .bind(target.databaseId, c.get('userId'), rawBatchId)
    .first()
  if (!batchRow) return c.json({ error: 'Batch not found' }, 404)

  const searchParams = new URLSearchParams()
  const from = c.req.query('from')
  const size = c.req.query('size')
  if (from !== undefined) searchParams.set('from', from)
  if (size !== undefined) searchParams.set('size', size)
  const qs = searchParams.toString() ? `?${searchParams.toString()}` : ''

  const batchId = encodeURIComponent(rawBatchId)
  const res = await livyFetch(target, `/batches/${batchId}/log${qs}`)
  if (res.status === 404) return c.json({ error: 'Batch not found' }, 404)
  return c.json(res.data, res.status as 200)
})

export default livy
