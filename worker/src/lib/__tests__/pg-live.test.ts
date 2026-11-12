import { describe, expect, it } from 'vitest'
import { normalizePostgresUrl } from '../pg-url'
import { openPostgresSession } from '../pg-executor'

// Opt-in live test: runs only when a real PostgreSQL connection string is provided in the
// environment (team secret, never committed). It proves the whole executor against a real
// free-tier server: handshake, read/write, the JSON-safe type mapping and one-connection batches.
//
//   NEON_POOLER_URL=… pnpm test -- pg-live
//
// It creates and drops its own table and touches nothing else.
const LIVE_URL = process.env.NEON_POOLER_URL ?? process.env.NEON_DIRECT_URL ?? ''

describe.skipIf(!LIVE_URL)('postgres executor against a live server', () => {
  const table = `zeta_live_${Date.now().toString(36)}`

  // A free-tier server can take several seconds to wake up before the first query.
  it('runs a real read/write round trip with JSON-safe types', { timeout: 90_000 }, async () => {
    const normalized = normalizePostgresUrl(LIVE_URL)
    expect(normalized.ok).toBe(true)
    if (!normalized.ok) return

    const session = await openPostgresSession(normalized.url)
    try {
      const create = await session.run(
        `create table ${table} (id bigint primary key, amount numeric(12,2), at timestamptz, blob bytea, doc jsonb)`,
        'write',
        5000
      )
      expect(create.changes).toBe(0)

      const insert = await session.run(
        `insert into ${table} values (9007199254740993, 12.34, '2026-11-12T15:39:41.123Z', '\\x0102', '{"n": 1}'), (2, 0.5, null, null, null)`,
        'write',
        5000
      )
      expect(insert.changes).toBe(2)

      const read = await session.run(`select * from ${table} order by id`, 'read', 5000)
      expect(read.truncated).toBe(false)
      expect(read.results[0]).toMatchObject({ id: '2', amount: '0.50', at: null, blob: null, doc: null })
      expect(read.results[1]).toEqual({
        id: '9007199254740993', // int8 arrives as a string, never a lossy number
        amount: '12.34', // numeric arrives as a string
        at: '2026-11-12T15:39:41.123Z', // ISO 8601
        blob: 'AQI=', // bytea as base64
        doc: { n: 1 }, // jsonb walked through the mapping
      })

      const update = await session.run(`update ${table} set amount = 1 where id = 2`, 'write', 5000)
      expect(update.changes).toBe(1)

      // The cap marks truncated results for reads that cannot be wrapped (this one is wrapped)
      const capped = await session.run(`select * from ${table}`, 'read', 1)
      expect(capped.results).toHaveLength(1)
      expect(capped.truncated).toBe(true)

      // A SQL error surfaces as a classified, readable error
      await expect(session.run('select * from zeta_missing_table_xyz', 'read', 5000)).rejects.toMatchObject({
        kind: 'sql',
      })
    } finally {
      await session.run(`drop table if exists ${table}`, 'write', 5000)
      await session.close()
    }
  })
})
