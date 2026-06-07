import { Hono } from 'hono'
import { cors } from 'hono/cors'
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

app.use('/api/*', cors({
  origin: (origin, c) => {
    const allowed = c.env.APP_URL?.trim().replace(/\/$/, '')
    if (!origin || !allowed) return allowed ?? null
    return origin.replace(/\/$/, '') === allowed ? origin : null
  },
  credentials: true,
  allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization'],
}))

app.use('/api/*', securityHeaders)

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

// ── Serve SPA (Workers Assets fallback) ──────────────────────────────────────

app.all('*', (c) => c.env.ASSETS.fetch(c.req.raw) as unknown as Response)

export default {
  fetch: app.fetch,
} satisfies ExportedHandler<Env>
