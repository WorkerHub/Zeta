import { Hono } from 'hono'
import type { Env, Variables } from '../types'
import { getSetting } from '../lib/db'
import { checkSetupRateLimit } from '../lib/auth'
import { runSetup } from '../lib/setup'

const setup = new Hono<{ Bindings: Env; Variables: Variables }>()

// Compares SHA-256 digests so neither the content nor the length of the secret leaks via timing.
async function secretsMatch(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder()
  const [da, db] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(a)),
    crypto.subtle.digest('SHA-256', enc.encode(b)),
  ])
  const va = new Uint8Array(da)
  const vb = new Uint8Array(db)
  let diff = 0
  for (let i = 0; i < va.length; i++) diff |= va[i]! ^ vb[i]!
  return diff === 0
}

// ── GET /api/setup/state ──────────────────────────────────────────────────────

// Public and unauthenticated: only reports whether the setup page is enabled, leaking nothing else
// (not whether the database is initialised, its schema, or its version). A missing settings table
// (database not yet initialised) and a missing row both mean the default: enabled. Registered
// before the GET '/*' 405 fallback below so it is not swallowed by it.
setup.get('/state', async (c) => {
  let value: string | null = null
  try {
    value = await getSetting(c.env, 'setup_page_enabled')
  } catch {
    // settings table does not exist yet — the database has not been initialised
  }
  return c.json({ enabled: value !== '0' })
})

// ── GET /api/setup/* (legacy) ─────────────────────────────────────────────────

// The old GET /api/setup/:secret form put the secret in the URL (history, logs, Referer).
// It never initialises anything now; it only points callers at the POST form.
setup.get('/*', (c) =>
  c.json({ error: 'Use POST /api/setup with a JSON body {"secret": "<SETUP_SECRET>"}.' }, 405, { Allow: 'POST' })
)

// ── POST /api/setup ───────────────────────────────────────────────────────────

setup.post('/', async (c) => {
  // Rate-limit by source IP before anything else — including the secret comparison — so a wrong
  // secret cannot be brute-forced unthrottled. Success and failure both count.
  const ip = c.req.header('cf-connecting-ip') ?? 'unknown'
  const { allowed, retryAfter } = await checkSetupRateLimit(c.env, ip)
  if (!allowed) {
    return c.json({ error: 'Too many setup attempts. Try again later.' }, 429, { 'Retry-After': String(retryAfter) })
  }

  const expected = c.env.SETUP_SECRET

  // SETUP_SECRET must be set; reject if missing or mismatched
  if (!expected || expected.trim() === '') {
    return c.json({ error: 'SETUP_SECRET is not configured on this Worker.' }, 500)
  }
  const body = await c.req.json<{ secret?: unknown }>().catch(() => null)
  if (typeof body?.secret !== 'string' || !body.secret) {
    return c.json({ error: 'A JSON body {"secret": "<SETUP_SECRET>"} is required.' }, 400)
  }
  if (!(await secretsMatch(body.secret, expected))) {
    return c.json({ error: 'Invalid setup secret.' }, 403)
  }

  const result = await runSetup(c.env)
  if (!result.ok) return c.json(result, 500)
  return c.json(result)
})

export default setup
