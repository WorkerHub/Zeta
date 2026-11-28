import { type Context, Hono } from 'hono'
import { getCookie } from 'hono/cookie'
import { createSparkUiSessionToken, verifySparkUiSessionToken } from '../lib/auth'
import { tables } from '../lib/db'
import { openSecret } from '../lib/secrets'
import { normalizeSparkAccess } from '../lib/spark-access'
import { requireAuth } from '../middleware/auth'
import { isSecure } from '../middleware/security'
import type { DatabaseRow, Env, Variables } from '../types'

const sparkUi = new Hono<{ Bindings: Env; Variables: Variables }>()
sparkUi.use('*', requireAuth)

export function rewriteSparkUiLocation(location: string, uiUrl: string): string {
  try {
    const locUrl = new URL(location)
    const targetUrl = new URL(uiUrl)
    if (locUrl.origin === targetUrl.origin) {
      let pathAndQuery = locUrl.pathname + locUrl.search + locUrl.hash
      if (targetUrl.pathname && targetUrl.pathname !== '/' && pathAndQuery.startsWith(targetUrl.pathname)) {
        pathAndQuery = pathAndQuery.slice(targetUrl.pathname.length)
      }
      if (!pathAndQuery.startsWith('/')) {
        pathAndQuery = `/${pathAndQuery}`
      }
      return `/spark-ui${pathAndQuery}`
    }
    return location
  } catch {
    if (location.startsWith('/spark-ui/')) {
      return location
    }
    if (location.startsWith('/')) {
      return `/spark-ui${location}`
    }
    return `/spark-ui/${location}`
  }
}

async function resolveTargetDatabase(
  c: Context<{ Bindings: Env; Variables: Variables }>,
  databaseId: string
): Promise<{ db: DatabaseRow; ui_url: string; ui_platform_token: string } | Response> {
  const T = tables(c.env)
  const db = await c.env.DB.prepare(`SELECT * FROM ${T.d1_databases} WHERE id = ?1 AND is_active = 1`)
    .bind(databaseId)
    .first<DatabaseRow>()
  if (!db) return c.json({ error: 'Database not found' }, 404)
  if (db.kind !== 'spark') return c.json({ error: 'Database is not a Spark database' }, 404)
  if (!db.connection_secret) return c.json({ error: 'Spark UI not configured' }, 404)

  let parsed: unknown
  try {
    const raw = await openSecret(c.env, db.connection_secret)
    parsed = JSON.parse(raw)
  } catch {
    return c.json({ error: 'Spark UI not configured' }, 404)
  }
  const accessResult = normalizeSparkAccess(parsed)
  if (!accessResult.ok || !accessResult.access.ui_url || !accessResult.access.ui_platform_token) {
    return c.json({ error: 'Spark UI not configured' }, 404)
  }

  const userId = c.get('userId')
  const role = c.get('userRole')
  if (role !== 'admin') {
    const permRow = await c.env.DB.prepare(
      `SELECT permission FROM ${T.user_database_permissions} WHERE user_id = ?1 AND database_id = ?2`
    )
      .bind(userId, db.id)
      .first<{ permission: string }>()
    if (!permRow || !['read', 'write', 'write_drop', 'manage'].includes(permRow.permission)) {
      return c.json({ error: 'Forbidden' }, 403)
    }
  }

  return {
    db,
    ui_url: accessResult.access.ui_url,
    ui_platform_token: accessResult.access.ui_platform_token,
  }
}

async function handleSparkUi(c: Context<{ Bindings: Env; Variables: Variables }>) {
  const dbParam = c.req.query('db')

  // First hit: ?db=<id>
  if (dbParam) {
    const resolved = await resolveTargetDatabase(c, dbParam)
    if (resolved instanceof Response) return resolved

    const sessionToken = await createSparkUiSessionToken(
      {
        userId: c.get('userId'),
        role: c.get('userRole'),
        databaseId: resolved.db.id,
      },
      c.env
    )
    const secure = isSecure(c)
    const flags = `HttpOnly; Path=/spark-ui; Max-Age=86400; SameSite=Lax${secure ? '; Secure' : ''}`
    c.header('Set-Cookie', `spark_ui_session=${sessionToken}; ${flags}`)
    return c.redirect('/spark-ui/', 302)
  }

  // Subsequent requests: parse databaseId from signed cookie
  const cookie = getCookie(c, 'spark_ui_session')
  if (!cookie) {
    return c.json({ error: 'Unauthorized' }, 401)
  }
  const session = await verifySparkUiSessionToken(cookie, c.env)
  if (!session) {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  const resolved = await resolveTargetDatabase(c, session.db)
  if (resolved instanceof Response) return resolved

  // Construct target URL
  const reqUrl = new URL(c.req.url)
  let remainder = reqUrl.pathname.slice('/spark-ui'.length)
  if (!remainder || remainder === '/') {
    remainder = '/'
  } else if (!remainder.startsWith('/')) {
    remainder = `/${remainder}`
  }
  const targetUrl = `${resolved.ui_url}${remainder}${reqUrl.search}`

  // Forward headers (excluding caller's Authorization, Cookies, Host)
  const forwardHeaders = new Headers()
  for (const [key, value] of c.req.raw.headers.entries()) {
    const k = key.toLowerCase()
    if (k === 'authorization' || k === 'cookie' || k === 'host' || k === 'connection' || k === 'keep-alive') {
      continue
    }
    forwardHeaders.set(key, value)
  }
  forwardHeaders.set('Authorization', `Bearer ${resolved.ui_platform_token}`)

  const fetchInit: RequestInit = {
    method: c.req.method,
    headers: forwardHeaders,
    redirect: 'manual',
  }
  if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
    fetchInit.body = c.req.raw.body
    ;(fetchInit as RequestInit & { duplex?: string }).duplex = 'half'
  }

  let proxyRes: Response
  try {
    proxyRes = await fetch(targetUrl, fetchInit)
  } catch (err) {
    console.error('Spark UI proxy request failed:', err instanceof Error ? err.message : String(err))
    return c.json({ error: 'Spark UI service unreachable' }, 502)
  }

  const resHeaders = new Headers(proxyRes.headers)
  resHeaders.delete('content-encoding')
  resHeaders.delete('content-length')

  const loc = resHeaders.get('location')
  if (loc) {
    resHeaders.set('location', rewriteSparkUiLocation(loc, resolved.ui_url))
  }

  return new Response(proxyRes.body, {
    status: proxyRes.status,
    statusText: proxyRes.statusText,
    headers: resHeaders,
  })
}

sparkUi.all('*', handleSparkUi)

export default sparkUi
