import { afterEach, describe, expect, it, vi } from 'vitest'
import { getMigrations } from '../../lib/migrations'
import { sealSecret } from '../../lib/secrets'
import type { Env } from '../../types'
import { bearer, callWorker, fakeEnv, postJson } from './fakes'
import { sqliteD1 } from './sqlite-d1'

// Opt-in live test for the batch's stop-at-first-error rule, against a real PostgreSQL server (the
// team's Neon instance; the connection string comes from the environment, never from the repo).
//
//   NEON_POOLER_URL=… pnpm test -- query-batch-live
//
// It creates its own table, proves the third statement of a halted batch never ran, and drops the
// table again — it touches nothing else.
const LIVE_URL = process.env.NEON_POOLER_URL ?? process.env.NEON_DIRECT_URL ?? ''

afterEach(() => vi.unstubAllGlobals())

describe.skipIf(!LIVE_URL)('batch stop-at-first-error against a live PostgreSQL server', () => {
  const table = `zeta_halt_${Date.now().toString(36)}`

  // The app database is a real in-memory SQLite with the production schema, so the registry,
  // permission and history statements all run for real; only the query target is remote.
  async function liveEnv(): Promise<Env> {
    const app = sqliteD1()
    for (const migration of getMigrations({ TABLE_PREFIX: '' })) app.sqlite.exec(migration.sql)
    const env = fakeEnv({ DB: app.db })
    const sealed = await sealSecret(env, JSON.stringify({ url: LIVE_URL }))
    app.sqlite.exec(`
      INSERT INTO users (id, email, name, role, created_at, updated_at)
        VALUES ('a1', 'admin@example.com', 'Admin', 'admin', 0, 0);
      INSERT INTO d1_databases (id, name, binding_name, kind, connection_secret, is_active, created_at)
        VALUES ('pg1', 'neon', 'pg:pg1', 'postgres', '${sealed}', 1, 0);
    `)
    return env
  }

  const post = async (env: Env, path: string, body: unknown) =>
    callWorker(env, path, postJson(body, { headers: await bearer(env, 'a1', 'admin') }))

  it('answers the two attempted statements and never runs the one after the failure', {
    timeout: 120_000,
  }, async () => {
    const env = await liveEnv()
    try {
      const res = await post(env, '/api/query/batch', {
        databaseId: 'pg1',
        statements: [
          `create table ${table} (id int)`,
          `select * from ${table}_missing`,
          `insert into ${table} values (1)`,
        ],
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as {
        results: Array<{ sql: string; error?: string }>
        halted?: boolean
      }
      console.log(`[query-batch-live] results=${body.results.length} halted=${String(body.halted)}`)
      console.log(`[query-batch-live] failed statement: ${String(body.results[1]?.error)}`)

      expect(body.results).toHaveLength(2)
      expect(body.results[0]!.error).toBeUndefined()
      expect(body.results[1]!.error).toMatch(/missing|does not exist/i)
      expect(body.halted).toBe(true)

      // The insert that followed the failure never ran: the table it would have written to is empty
      const counted = await post(env, '/api/query', { databaseId: 'pg1', sql: `select count(*) as n from ${table}` })
      expect(counted.status).toBe(200)
      const rows = ((await counted.json()) as { results: Array<{ n: unknown }> }).results
      console.log(`[query-batch-live] rows written by the third statement: ${String(rows[0]?.n)}`)
      expect(String(rows[0]?.n)).toBe('0')
    } finally {
      await post(env, '/api/query', { databaseId: 'pg1', sql: `drop table if exists ${table}` })
    }
  })
})
