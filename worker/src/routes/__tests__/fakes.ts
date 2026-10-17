import type { D1Database, KVNamespace } from '@cloudflare/workers-types'
import type { Env } from '../../types'

export interface DbCall {
  sql: string
  args: unknown[]
}

// Returns the row (first), rows (all) or nothing (run) for a statement.
export type DbHandler = (sql: string, args: unknown[]) => unknown

// Minimal in-memory stand-in for a D1 binding: every executed statement is recorded and
// answered by `handler`.
export function fakeD1(handler: DbHandler = () => null) {
  const calls: DbCall[] = []
  const exec = (sql: string, args: unknown[]) => {
    calls.push({ sql, args })
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
    run: async () => {
      exec(sql, args)
      return { results: [], meta: { changes: 1 } }
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
  return { db: db as unknown as D1Database, calls }
}

export function fakeKV(): KVNamespace {
  const store = new Map<string, string>()
  return {
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string) => { store.set(key, value) },
    delete: async (key: string) => { store.delete(key) },
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
export async function callWorker(env: Env, path: string, init?: RequestInit): Promise<Response> {
  const { default: worker } = await import('../../index')
  const pending: Promise<unknown>[] = []
  const ctx = {
    waitUntil: (p: Promise<unknown>) => { pending.push(p) },
    passThroughOnException: () => {},
    props: {},
  }
  const res = await worker.fetch(
    new Request(`http://localhost:8787${path}`, init) as never,
    env,
    ctx as never,
  )
  await Promise.allSettled(pending)
  return res as unknown as Response
}

export const postJson = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})
