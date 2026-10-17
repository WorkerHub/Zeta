import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { bodyLimit } from 'hono/body-limit'
import type { Env, Variables } from './types'
import { securityHeaders } from './middleware/security'
import auth from './routes/auth'
import profile from './routes/profile'
import databases from './routes/databases'
import query from './routes/query'
import notebooks from './routes/notebooks'
import admin from './routes/admin'
import setup from './routes/setup'

const app = new Hono<{ Bindings: Env; Variables: Variables }>()

// ── Global middleware ─────────────────────────────────────────────────────────

app.use(
  '/api/*',
  cors({
    // Only the configured APP_URL is allowed. Requests without an Origin (same-origin GETs, curl)
    // need no CORS headers, and opaque origins (data:, sandboxed frames) send "null", which never
    // matches.
    origin: (origin, c) => {
      const allowed = c.env.APP_URL?.trim().replace(/\/$/, '')
      if (!origin || !allowed) return null
      return origin.replace(/\/$/, '') === allowed ? origin : null
    },
    credentials: true,
    allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization'],
  })
)

app.use('*', securityHeaders)

// Rejects oversized bodies before any route parses them. The largest legitimate payloads (a 512K
// notebook, a batch of statements) stay well below this.
const MAX_BODY_BYTES = 4 * 1024 * 1024
app.use(
  '/api/*',
  bodyLimit({ maxSize: MAX_BODY_BYTES, onError: (c) => c.json({ error: 'Request body too large' }, 413) })
)

// ── API routes ────────────────────────────────────────────────────────────────

app.route('/api/auth', auth)
app.route('/api/profile', profile)
app.route('/api/databases', databases)
app.route('/api/query', query)
app.route('/api/notebooks', notebooks)
app.route('/api/admin', admin)
app.route('/api/setup', setup)

// ── Health check ──────────────────────────────────────────────────────────────

app.get('/api/health', (c) => c.json({ ok: true }))

app.all('/api/*', (c) => c.json({ error: 'Not found' }, 404))

// ── Serve SPA (Workers Assets fallback) ──────────────────────────────────────

app.all('*', async (c) => {
  const res = (await c.env.ASSETS.fetch(c.req.raw)) as unknown as Response
  return new Response(res.body, res) // copy so security headers can be added
})

export default {
  fetch: app.fetch,
} satisfies ExportedHandler<Env>
