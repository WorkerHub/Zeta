import { describe, expect, it } from 'vitest'
import { normalizeSparkAccess, type SparkAccess } from '../spark-access'
import { openSparkSession, SparkQueryError, testSparkConnection } from '../spark-executor'
import { sparkSessionKey } from '../spark-profile'

// Opt-in live test: runs only when the published Spark port's credentials are in the environment
// (team secret SPARK_ACCESS — JSON `{url, platform_token, app_token}`; never committed).
//
//   SPARK_ACCESS='{"url":…,"platform_token":…,"app_token":…}' ./node_modules/.bin/vitest run spark-live
//
// Everything it prints is prefixed `[spark-live]`, so the evidence can be pasted into the delivery
// report. It runs read-only statements plus one table of its own, which it drops again.
const RAW = process.env.SPARK_ACCESS ?? ''

const access = ((): SparkAccess | null => {
  if (!RAW) return null
  try {
    const result = normalizeSparkAccess(JSON.parse(RAW))
    return result.ok ? result.access : null
  } catch {
    return null
  }
})()

const describeLive = access ? describe : describe.skip

const SLOW = { timeout: 300_000 }

function log(label: string, value: unknown) {
  console.log(`[spark-live] ${label}:`, JSON.stringify(value))
}

function requireAccess(): SparkAccess {
  if (!access) throw new Error('SPARK_ACCESS is not a valid payload')
  return access
}

describeLive('spark-live: the published port', () => {
  it('proves the registration with /health and one statement', SLOW, async () => {
    const { server_version } = await testSparkConnection(requireAccess())
    log('spark version', server_version)
    expect(server_version).toMatch(/^\d+\.\d+/)
  })

  it('keeps the application token out of the URL and rejects a wrong one as auth', SLOW, async () => {
    const good = requireAccess()
    const session = await openSparkSession({ ...good, app_token: 'definitely-wrong' })
    try {
      const error = await session.run('select 1', 'read', 5000).catch((err) => err)
      log('wrong app token', { kind: error.kind, code: error.code })
      expect(error).toBeInstanceOf(SparkQueryError)
      expect(error.kind).toBe('auth')
      expect(error.code).toBe('spark_app_token')
      expect(error.message).not.toContain(good.platform_token)
      expect(error.message).not.toContain('definitely-wrong')
    } finally {
      await session.close()
    }
  })

  it('returns 1000 rows, caps at 5000 and reports truncation exactly', SLOW, async () => {
    const session = await openSparkSession(requireAccess())
    try {
      const thousand = await session.run('select id from range(1000)', 'read', 5000)
      log('1000 rows', { rows: thousand.results.length, truncated: thousand.truncated })
      expect(thousand.results).toHaveLength(1000)
      expect(thousand.truncated).toBe(false)

      const exact = await session.run('select id from range(5000)', 'read', 5000)
      log('5000 rows', { rows: exact.results.length, truncated: exact.truncated })
      expect(exact.results).toHaveLength(5000)
      expect(exact.truncated).toBe(false)

      const over = await session.run('select id from range(5001)', 'read', 5000)
      log('5001 rows', { rows: over.results.length, truncated: over.truncated })
      expect(over.results).toHaveLength(5000)
      expect(over.truncated).toBe(true)
    } finally {
      await session.close()
    }
  })

  it('classifies a missing table as a sql failure and never echoes the tokens', SLOW, async () => {
    const good = requireAccess()
    const session = await openSparkSession(good)
    try {
      const error = await session.run(`select * from zeta_missing_${Date.now()}`, 'read', 5000).catch((err) => err)
      log('missing table', { kind: error.kind, code: error.code, head: String(error.message).slice(0, 120) })
      expect(error).toBeInstanceOf(SparkQueryError)
      expect(error.kind).toBe('sql')
      expect(error.message.length).toBeGreaterThan(0)
      expect(error.message).not.toContain(good.url)
      expect(error.message).not.toContain(good.platform_token)
      expect(error.message).not.toContain(good.app_token)
    } finally {
      await session.close()
    }
  })

  it('lets USE through as a session statement and reports a missing database as sql', SLOW, async () => {
    const session = await openSparkSession(requireAccess())
    try {
      // `USE` is no longer refused by the guard. A database that does not exist is reported by Spark
      // itself, through the ordinary SQL-error path.
      const error = await session.run(`use zeta_absent_${Date.now()}`, 'read', 5000).catch((err) => err)
      log('USE a missing database', { kind: error.kind, code: error.code, head: String(error.message).slice(0, 160) })
      expect(error).toBeInstanceOf(SparkQueryError)
      expect(error.kind).toBe('sql')
    } finally {
      await session.close()
    }
  })

  it('runs a write without inventing an affected-row count', SLOW, async () => {
    const table = `zeta_live_${Date.now()}`
    const session = await openSparkSession(requireAccess())
    try {
      const created = await session.run(`create table ${table} (id int)`, 'write', 5000)
      log('create table result', created)
      expect(created).toEqual({ results: [], meta: {}, truncated: false })

      const inserted = await session.run(`insert into ${table} values (1), (2)`, 'write', 5000)
      log('insert result', inserted)
      expect(inserted).toEqual({ results: [], meta: {}, truncated: false })

      const counted = await session.run(`select count(*) as n from ${table}`, 'read', 5000)
      log('rows after insert', counted.results[0])
      expect(Number(counted.results[0]?.n)).toBe(2)
    } finally {
      await session.run(`drop table if exists ${table}`, 'write', 5000).catch(() => {})
      await session.close()
    }
  })
})

// One request carries the caller's `session`, and the machine keeps one SparkSession per value. The
// block below proves both halves of that contract from Zeta's side: a temp view stays inside the
// session that created it, while a table in the metastore is there for every session. It is gated on
// its own switch because it needs the service that understands the field — run it after that upgrade:
//
//   SPARK_LIVE_MULTI_SESSION=1 ./node_modules/.bin/vitest run spark-live
const MULTI_SESSION = process.env.SPARK_LIVE_MULTI_SESSION === '1'
const describeMultiSession = access && MULTI_SESSION ? describe : describe.skip

describeMultiSession('spark-live: one session per caller', () => {
  it('keeps temp views private and the metastore shared across two sessions', SLOW, async () => {
    const stamp = Date.now()
    const view = `zeta_sess_view_${stamp}`
    const table = `zeta_sess_shared_${stamp}`
    const first = await openSparkSession(requireAccess(), { session: `zeta-live-a-${stamp}` })
    const second = await openSparkSession(requireAccess(), { session: `zeta-live-b-${stamp}` })
    try {
      // A temp view belongs to the session that created it, and to no other
      await first.run(`create or replace temp view ${view} as select 1 as x`, 'write', 5000)
      const own = await first.run(`select x from ${view}`, 'read', 5000)
      log('same session sees its temp view', own.results[0])
      expect(Number(own.results[0]?.x)).toBe(1)

      const other = await second.run(`select * from ${view}`, 'read', 5000).catch((err) => err)
      log('other session cannot see the temp view', { kind: other.kind, code: other.code })
      expect(other).toMatchObject({ kind: 'sql', code: 'spark_sql' })

      // The metastore is shared: what one session writes, the other reads
      await first.run(`create table ${table} (id int)`, 'write', 5000)
      await first.run(`insert into ${table} values (1), (2), (3)`, 'write', 5000)
      const shared = await second.run(`select count(*) as n from ${table}`, 'read', 5000)
      log('other session reads the shared table', shared.results[0])
      expect(Number(shared.results[0]?.n)).toBe(3)
    } finally {
      await first.run(`drop table if exists ${table}`, 'write', 5000).catch(() => {})
      await first.close()
      await second.close()
    }
  })

  // The default configuration has to come back when the caller switches back to it (§9.1). The service
  // applies `config` per request and never resets what an earlier request set, so it is the session
  // key — not the presence of the field — that restores the defaults (lib/spark-profile.ts). This runs
  // the real repro: default → profile → default → profile, reading the exchange's partition count out
  // of the plan (SparkSQL offers no `SET`, and its sessions are per named session, not per instance).
  it('restores the default configuration when the caller switches back to it', SLOW, async () => {
    const userId = `zeta-live-cfg-${Date.now()}`
    const profile = { 'spark.sql.shuffle.partitions': '777' }
    const explain = 'EXPLAIN SELECT k, count(*) FROM (SELECT id % 10 AS k FROM range(1000)) GROUP BY k'
    const partitions = (executed: { results: Record<string, unknown>[] }): number => {
      const plan = JSON.stringify(executed.results)
      const match = plan.match(/hashpartitioning\([^)]*?([0-9]+)\)/)
      expect(match, `no exchange in the plan: ${plan.slice(0, 200)}`).not.toBeNull()
      return Number(match![1])
    }

    const defaultKey = await sparkSessionKey(userId, null)
    const profileKey = await sparkSessionKey(userId, profile)
    expect(profileKey).not.toBe(defaultKey)

    const plain = await openSparkSession(requireAccess(), { session: defaultKey })
    const profiled = await openSparkSession(requireAccess(), { session: profileKey, config: profile })
    try {
      const before = partitions(await plain.run(explain, 'read', 50))
      log('default configuration before the profile', before)
      // The instance's own default is what a fresh session gets; 777 is the profile's value
      expect(before).not.toBe(777)

      expect(partitions(await profiled.run(explain, 'read', 50))).toBe(777)
      log('profile configuration', 777)

      const back = partitions(await plain.run(explain, 'read', 50))
      log('default configuration after switching back', back)
      expect(back).toBe(before)

      // And the other direction still works: selecting the profile again reaches its session
      expect(partitions(await profiled.run(explain, 'read', 50))).toBe(777)
    } finally {
      await plain.close()
      await profiled.close()
    }
  })
})
