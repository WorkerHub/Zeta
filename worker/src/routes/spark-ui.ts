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

export function rewriteSparkUiLocation(location: string, uiUrl: string, requestUrl?: string): string {
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
    if (
      location === '/spark-ui' ||
      location.startsWith('/spark-ui/') ||
      location.startsWith('/spark-ui?') ||
      location.startsWith('/spark-ui#')
    ) {
      return location
    }
    if (location.startsWith('/')) {
      return `/spark-ui${location}`
    }
    if (requestUrl) {
      try {
        const resolved = new URL(location, requestUrl)
        let pathname = resolved.pathname
        if (!pathname.startsWith('/spark-ui')) {
          pathname = `/spark-ui${pathname.startsWith('/') ? pathname : `/${pathname}`}`
        }
        return `${pathname}${resolved.search}${resolved.hash}`
      } catch {
        // Fall back
      }
    }
    const clean = location.replace(/^(\.\.\/)+/, '')
    return `/spark-ui/${clean}`
  }
}

export function rewriteSparkUiUrl(val: string, uiUrl: string, _requestUrl?: string): string {
  if (!val || typeof val !== 'string') return val
  const trimmed = val.trim()
  if (
    !trimmed ||
    trimmed.startsWith('#') ||
    trimmed.startsWith('data:') ||
    trimmed.startsWith('javascript:') ||
    trimmed.startsWith('mailto:')
  ) {
    return val
  }

  // If it's an absolute URL
  try {
    const parsed = new URL(trimmed)
    const target = new URL(uiUrl)

    // The upstream Spark is configured with spark.ui.reverseProxy + a fixed proxyBase whose host
    // (e.g. https://zeta.oneboy.app) differs from the private ui_url. Its HTML therefore carries
    // absolute URLs such as https://zeta.oneboy.app/spark-ui/proxy/<appId>/static/webui.css.
    // Drop the host so they resolve against the current origin: that keeps them behind this
    // reverse proxy and admits them under the /spark-ui CSP's 'self' source whitelist, no matter
    // which deployment domain (custom or *.workers.dev) the browser actually used.
    const pathAndQuery = parsed.pathname + parsed.search + parsed.hash
    if (
      pathAndQuery === '/spark-ui' ||
      pathAndQuery.startsWith('/spark-ui/') ||
      pathAndQuery.startsWith('/spark-ui?') ||
      pathAndQuery.startsWith('/spark-ui#')
    ) {
      return pathAndQuery
    }

    // Absolute URL on the private ui_url origin (the upstream echoed its own address).
    if (parsed.origin === target.origin) {
      let p = pathAndQuery
      if (target.pathname && target.pathname !== '/' && p.startsWith(target.pathname)) {
        p = p.slice(target.pathname.length)
      }
      if (!p.startsWith('/')) {
        p = `/${p}`
      }
      return `/spark-ui${p}`
    }
    // External absolute URL (e.g. https://spark.apache.org)
    return val
  } catch {
    // Relative or domain-relative URL
  }

  // Already prefixed
  if (
    trimmed === '/spark-ui' ||
    trimmed.startsWith('/spark-ui/') ||
    trimmed.startsWith('/spark-ui?') ||
    trimmed.startsWith('/spark-ui#')
  ) {
    return val
  }

  // Root-relative
  if (trimmed.startsWith('/')) {
    return `/spark-ui${trimmed}`
  }

  // Relative with ./ or ../ or naked relative
  if (trimmed.startsWith('./')) {
    const rest = trimmed.slice(2)
    return rest.startsWith('/') ? `/spark-ui${rest}` : `/spark-ui/${rest}`
  }
  if (trimmed.startsWith('../')) {
    const clean = trimmed.replace(/^(\.\.\/)+/, '')
    return clean.startsWith('/') ? `/spark-ui${clean}` : `/spark-ui/${clean}`
  }

  // Naked relative like "static/bootstrap.min.css" or "jobs/job?id=1"
  return `/spark-ui/${trimmed}`
}

export function rewriteSparkUiHtml(html: string, uiUrl: string, requestUrl?: string): string {
  if (!html || typeof html !== 'string') return html

  // 1. Rewrite <base href="...">
  let result = html.replace(/<base(\s+[^>]*)?>/gi, (match) => {
    return match.replace(/href\s*=\s*(["'])(.*?)\1/i, (_m, quote) => `href=${quote}/spark-ui/${quote}`)
  })

  // 2. Rewrite HTML attributes (href, src, action) on elements
  result = result.replace(/<(link|script|img|a|form|source|iframe)\b([^>]*)>/gi, (_match, tag, rest) => {
    let updatedRest = rest.replace(
      /\b(href|src|action)\s*=\s*(["'])(.*?)\2/gi,
      (_attrMatch: string, attrName: string, quote: string, attrVal: string) => {
        const rewritten = rewriteSparkUiUrl(attrVal, uiUrl, requestUrl)
        return `${attrName}=${quote}${rewritten}${quote}`
      }
    )
    updatedRest = updatedRest.replace(
      /\bsrcset\s*=\s*(["'])(.*?)\1/gi,
      (_attrMatch: string, quote: string, attrVal: string) => {
        const rewritten = attrVal
          .split(',')
          .map((part) => {
            const trimmed = part.trim()
            const [src, ...restTokens] = trimmed.split(/\s+/)
            if (!src) return part
            return [rewriteSparkUiUrl(src, uiUrl, requestUrl), ...restTokens].join(' ')
          })
          .join(', ')
        return `srcset=${quote}${rewritten}${quote}`
      }
    )
    return `<${tag}${updatedRest}>`
  })

  // 3. Rewrite inline script references to setUIRoot and uiRoot
  result = result.replace(/setUIRoot\s*\(\s*(['"])(.*?)\1\s*\)/g, (_match, quote) => {
    return `setUIRoot(${quote}/spark-ui${quote})`
  })
  result = result.replace(/(var\s+)?uiRoot\s*=\s*(['"])(.*?)\2/g, (_match, varKeyword, quote) => {
    return `${varKeyword || ''}uiRoot = ${quote}/spark-ui${quote}`
  })
  result = result.replace(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi, (_match, attrs, content) => {
    const rewritten = content.replace(/(['"])\/(?!spark-ui\/)api\/v1\//g, '$1/spark-ui/api/v1/')
    return `<script${attrs}>${rewritten}</script>`
  })

  // 4. Any direct mention of uiUrl origin or uiUrl base in the HTML (prevent leakage)
  try {
    const parsedTarget = new URL(uiUrl)
    const fullBase = `${parsedTarget.origin}${parsedTarget.pathname.replace(/\/+$/, '')}`
    if (result.includes(fullBase)) {
      result = result.replaceAll(fullBase, '/spark-ui')
    }
    const targetOrigin = parsedTarget.origin
    if (result.includes(targetOrigin)) {
      result = result.replaceAll(targetOrigin, '/spark-ui')
    }
    result = result.replaceAll('/spark-ui/spark-ui', '/spark-ui')
  } catch {}

  return result
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

async function setSparkUiSessionCookie(
  c: Context<{ Bindings: Env; Variables: Variables }>,
  databaseId: string
): Promise<void> {
  const sessionToken = await createSparkUiSessionToken(
    {
      userId: c.get('userId'),
      role: c.get('userRole'),
      databaseId,
    },
    c.env
  )
  const secure = isSecure(c)
  const flags = `HttpOnly; Path=/spark-ui; Max-Age=86400; SameSite=Lax${secure ? '; Secure' : ''}`
  c.header('Set-Cookie', `spark_ui_session=${sessionToken}; ${flags}`)
}

export const sparkUiApi = new Hono<{ Bindings: Env; Variables: Variables }>()
sparkUiApi.use('*', requireAuth)

sparkUiApi.post('/session', async (c) => {
  const body = await c.req.json<{ db?: unknown }>().catch(() => null)
  if (!body || typeof body.db !== 'string' || !body.db.trim()) {
    return c.json({ error: 'db is required' }, 400)
  }

  const resolved = await resolveTargetDatabase(c, body.db.trim())
  if (resolved instanceof Response) return resolved

  await setSparkUiSessionCookie(c, resolved.db.id)
  return c.body(null, 204)
})

async function handleSparkUi(c: Context<{ Bindings: Env; Variables: Variables }>) {
  const dbParam = c.req.query('db')

  // First hit: ?db=<id>
  if (dbParam) {
    const resolved = await resolveTargetDatabase(c, dbParam)
    if (resolved instanceof Response) return resolved

    await setSparkUiSessionCookie(c, resolved.db.id)
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
  forwardHeaders.set('X-Forwarded-Context', '/spark-ui')
  forwardHeaders.set('X-Forwarded-Prefix', '/spark-ui')
  forwardHeaders.set('X-Forwarded-Proto', reqUrl.protocol.replace(':', ''))
  forwardHeaders.set('X-Forwarded-Host', reqUrl.host)

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
    resHeaders.set('location', rewriteSparkUiLocation(loc, resolved.ui_url, c.req.url))
  }

  const contentType = resHeaders.get('content-type') || ''
  if (contentType.includes('text/html') || contentType.includes('application/xhtml+xml')) {
    const rawHtml = await proxyRes.text()
    const rewrittenHtml = rewriteSparkUiHtml(rawHtml, resolved.ui_url, c.req.url)
    return new Response(rewrittenHtml, {
      status: proxyRes.status,
      statusText: proxyRes.statusText,
      headers: resHeaders,
    })
  }

  if (contentType.includes('application/json')) {
    const rawJson = await proxyRes.text()
    let sanitizedJson = rawJson
    try {
      const parsedTarget = new URL(resolved.ui_url)
      const fullBase = `${parsedTarget.origin}${parsedTarget.pathname.replace(/\/+$/, '')}`
      if (sanitizedJson.includes(fullBase)) {
        sanitizedJson = sanitizedJson.replaceAll(fullBase, '/spark-ui')
      }
      if (sanitizedJson.includes(parsedTarget.origin)) {
        sanitizedJson = sanitizedJson.replaceAll(parsedTarget.origin, '/spark-ui')
      }
    } catch {}
    return new Response(sanitizedJson, {
      status: proxyRes.status,
      statusText: proxyRes.statusText,
      headers: resHeaders,
    })
  }

  return new Response(proxyRes.body, {
    status: proxyRes.status,
    statusText: proxyRes.statusText,
    headers: resHeaders,
  })
}

sparkUi.all('*', handleSparkUi)

export default sparkUi
