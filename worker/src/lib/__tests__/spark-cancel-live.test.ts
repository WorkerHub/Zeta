import { describe, expect, it } from 'vitest'
import { normalizeSparkAccess, type SparkAccess } from '../spark-access'
import { cancelSparkExecution, openSparkSession, SparkQueryError } from '../spark-executor'

// Opt-in live test for cancellation against the published Spark port (team secret SPARK_ACCESS —
// JSON `{url, platform_token, app_token}`; never committed).
//
//   SPARK_ACCESS='{"url":…,"platform_token":…,"app_token":…}' ./node_modules/.bin/vitest run spark-cancel-live
//
// It works on a session of its own (`zeta-cancel-live-…`), so no other caller's statements,
// temporary views or current database are touched. Everything it prints is prefixed
// `[spark-cancel-live]`, so the evidence can be pasted into the delivery report.
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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function log(label: string, value: unknown) {
  console.log(`[spark-cancel-live] ${label}:`, JSON.stringify(value))
}

// A statement that keeps the machine busy for a few seconds: the join over a large range is the
// cancel window the spike measured (~3.5 s for 1e9 × 5).
const LONG = 'select sum(a.id + b.id) as total from range(1000000000) a cross join range(5) b'

describe.skipIf(access === null)('spark cancellation against the live service', () => {
  const session = `zeta-cancel-live-${Date.now().toString(36)}`

  function requireAccess(): SparkAccess {
    if (!access) throw new Error('SPARK_ACCESS is not a valid payload')
    return access
  }

  it('stops a running job via /cancel and keeps the session alive', { timeout: 300_000 }, async () => {
    const execution = crypto.randomUUID()
    const opened = await openSparkSession(requireAccess(), { session, execution })
    try {
      const running = opened.run(LONG, 'read', 10).then(
        () => null,
        (err: unknown) => err
      )
      await sleep(1000)
      const cancelledAt = Date.now()
      expect(await cancelSparkExecution(requireAccess(), { session, execution })).toEqual({ ok: true })

      const outcome = await running
      const stopLatency = Date.now() - cancelledAt
      log('stop latency after the cancel response (ms)', stopLatency)
      // The service answers a killed job with its ordinary 200 + error stack; the route turns that
      // into `cancelled` from its registry row, so here it still arrives as a SparkQueryError.
      expect(outcome).toBeInstanceOf(SparkQueryError)
      expect(stopLatency).toBeLessThan(3000)

      // The session survives: same session, next statement, and its current database is intact
      const after = await opened.run('select 1 as ok', 'read', 1)
      expect(after.results).toEqual([{ ok: 1 }])
      const database = await opened.run('select current_database() as db', 'read', 1)
      expect(database.results).toHaveLength(1)
      log('after cancel', { ok: after.results, currentDatabase: database.results })
    } finally {
      await opened.close()
    }
  })

  it('answers 200 for a cancel with nothing running (idempotent)', { timeout: 300_000 }, async () => {
    expect(await cancelSparkExecution(requireAccess(), { session, execution: crypto.randomUUID() })).toEqual({
      ok: true,
    })
  })

  it('does not stop a statement whose execution id differs (the kill is execution-level)', { timeout: 300_000 }, async () => {
    const execution = crypto.randomUUID()
    const opened = await openSparkSession(requireAccess(), { session, execution })
    try {
      const running = opened.run(LONG, 'read', 10).then(
        (result) => ({ completed: true as const, result }),
        (err: unknown) => ({ completed: false as const, err })
      )
      await sleep(1200)
      // Another execution of the same session: if the service grouped jobs by session alone, this
      // cancel would kill the statement above
      expect(await cancelSparkExecution(requireAccess(), { session, execution: crypto.randomUUID() })).toEqual({
        ok: true,
      })

      const outcome = await running
      log('wrong-execution cancel outcome', outcome.completed)
      expect(outcome.completed).toBe(true)
    } finally {
      await opened.close()
    }
  })
})
