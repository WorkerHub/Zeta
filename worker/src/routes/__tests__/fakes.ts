import type { D1Database, KVNamespace } from '@cloudflare/workers-types'
import type { Env } from '../../types'
import { createAccessToken } from '../../lib/auth'

export interface DbCall {
  sql: string
  args: unknown[]
}

// Returns the row (first), rows (all) or nothing (run) for a statement.
export type DbHandler = (sql: string, args: unknown[]) => unknown

// Emulates the rate_limits statements issued by lib/auth.ts against an in-memory map.
function rateLimitTable() {
  const rows = new Map<string, { count: number; expires_at: number }>()
  const exec = (sql: string, args: unknown[]): unknown => {
    if (sql.startsWith('INSERT INTO')) {
      const [key, expiresAt, ts] = args as [string, number, number]
      const row = rows.get(key)
      const next =
        !row || row.expires_at <= ts
          ? { count: 1, expires_at: expiresAt }
          : { count: row.count + 1, expires_at: row.expires_at }
      rows.set(key, next)
      return { count: next.count }
    }
    if (sql.startsWith('UPDATE')) {
      const row = rows.get(args[0] as string)
      if (row) row.count = Math.max(row.count - 1, 0)
      return null
    }
    if (sql.includes('WHERE key = ?1')) rows.delete(args[0] as string)
    else for (const [key, row] of rows) if (row.expires_at <= (args[0] as number)) rows.delete(key)
    return null
  }
  return { rows, exec }
}

// Minimal in-memory stand-in for a D1 binding: every executed statement is recorded and
// answered by `handler`. Rate-limit counters are emulated unless `rateLimits` is false, in which
// case those statements go to `handler` too (returning null makes lib/auth.ts fall back to KV).
export function fakeD1(handler: DbHandler = () => null, opts: { rateLimits?: boolean } = {}) {
  const calls: DbCall[] = []
  const rateLimits = rateLimitTable()
  const exec = (sql: string, args: unknown[]) => {
    calls.push({ sql, args })
    if (opts.rateLimits !== false && /rate_limits\b/.test(sql)) return rateLimits.exec(sql, args)
    return handler(sql, args)
  }
  const statement = (sql: string, args: unknown[] = []) => ({
    sql,
    args,
    bind: (...next: unknown[]) => statement(sql, next),
    first: async () => exec(sql, args) ?? null,
    all: async () => {
      const rows = exec(sql, args)
      return { results: Array.isArray(rows) ? rows : [], meta: {} }
    },
    // `handler` may return { changes: n } to report how many rows a run() touched (default 1).
    run: async () => {
      const res = exec(sql, args) as { changes?: unknown } | null | undefined
      return { results: [], meta: { changes: typeof res?.changes === 'number' ? res.changes : 1 } }
    },
  })
  const db = {
    prepare: (sql: string) => statement(sql),
    batch: async (stmts: Array<ReturnType<typeof statement>>) =>
      stmts.map((s) => {
        exec(s.sql, s.args)
        return { results: [], meta: {} }
      }),
  }
  return { db: db as unknown as D1Database, calls, rateLimits: rateLimits.rows }
}

export function fakeKV(): KVNamespace {
  const store = new Map<string, string>()
  return {
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string) => {
      store.set(key, value)
    },
    delete: async (key: string) => {
      store.delete(key)
    },
  } as unknown as KVNamespace
}

export function fakeEnv(overrides: Partial<Env> = {}): Env {
  return {
    DB: fakeD1().db,
    KV: fakeKV(),
    ASSETS: { fetch: async () => new Response('spa') },
    JWT_SECRET: 'test-jwt-secret',
    ENCRYPTION_KEY: 'ab'.repeat(32),
    SETUP_SECRET: 'test-setup-secret',
    APP_URL: 'http://localhost:8787',
    ...overrides,
  } as Env
}

// Sends a request through the real Worker entry point and waits for waitUntil() work.
// `path` may also be an absolute URL (e.g. to send it over https).
export async function callWorker(env: Env, path: string, init?: RequestInit): Promise<Response> {
  const { default: worker } = await import('../../index')
  const pending: Promise<unknown>[] = []
  const ctx = {
    waitUntil: (p: Promise<unknown>) => {
      pending.push(p)
    },
    passThroughOnException: () => {},
    props: {},
  }
  const res = await worker.fetch(
    new Request(path.startsWith('http') ? path : `http://localhost:8787${path}`, init) as never,
    env,
    ctx as never
  )
  await Promise.allSettled(pending)
  return res as unknown as Response
}

export const postJson = (body: unknown, extra: RequestInit = {}): RequestInit => ({
  method: 'POST',
  ...extra,
  headers: { 'Content-Type': 'application/json', ...(extra.headers as Record<string, string> | undefined) },
  body: JSON.stringify(body),
})

export async function bearer(env: Env, userId: string, role: 'admin' | 'member' = 'member') {
  return { Authorization: `Bearer ${await createAccessToken(userId, role, env)}` }
}
