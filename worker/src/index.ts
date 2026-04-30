import { Hono } from 'hono'
import { cors } from 'hono/cors'
import type { Env, Variables } from './types'
import { securityHeaders } from './middleware/security'
import auth from './routes/auth'
import profile from './routes/profile'
import databases from './routes/databases'
import query from './routes/query'
import admin from './routes/admin'
import setup from './routes/setup'

const app = new Hono<{ Bindings: Env; Variables: Variables }>()

// ── Global middleware ─────────────────────────────────────────────────────────

app.use('/api/*', cors({
  origin: (origin, c) => origin ?? c.env.APP_URL,
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
app.route('/api/admin', admin)
app.route('/api/setup', setup)

// ── Health check ──────────────────────────────────────────────────────────────

app.get('/api/health', (c) => c.json({ ok: true }))

// ── Serve SPA (Workers Assets fallback) ──────────────────────────────────────

const SPA_PREFIXES = new Set([
  '/login', '/register', '/verify-email', '/reset-password',
  '/forgot-password', '/dashboard', '/query', '/admin', '/profile',
])

app.get('/:slug', async (c, next) => {
  const slug = c.req.param('slug')
  if (SPA_PREFIXES.has(`/${slug}`)) return next()
  if (slug.includes('.')) return next()
  return next()
})

app.all('*', (c) => c.env.ASSETS.fetch(c.req.raw) as unknown as Response)

export default {
  fetch: app.fetch,
} satisfies ExportedHandler<Env>
