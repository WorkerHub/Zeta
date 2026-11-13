import { describe, expect, it } from 'vitest'
import { describeMySqlError, openMySqlSession, testMySqlConnection } from '../mysql-executor'
import { normalizeMySqlUrl } from '../mysql-url'

// Opt-in live test: runs only when a real TiDB Cloud Starter connection string is provided in the
// environment (team secret, never committed). It walks the re-check list of the phase-2 plan (§10):
// normalisation, server version, the type mapping (BLOB/BIT byte-for-byte), the 5000-row cap, the
// three failure classes, the absence of session state and one HTTP call per batch statement.
//
//   TIDB_URL=… pnpm test -- mysql-live
//
// Everything it prints is prefixed `[mysql-live]` so the evidence can be pasted into the delivery
// report. It creates and drops its own table and touches nothing else.
const LIVE_URL = process.env.TIDB_URL ?? ''

function hexOfBase64(value: unknown): string {
  if (typeof value !== 'string') return `<not a string: ${typeof value}>`
  return Array.from(atob(value), (ch) => ch.charCodeAt(0).toString(16).padStart(2, '0')).join('')
}

function log(label: string, value: unknown) {
  console.log(`[mysql-live] ${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}`)
}

describe.skipIf(!LIVE_URL)('mysql executor against a live TiDB Cloud Starter', () => {
  const table = `zeta_live_${Date.now().toString(36)}`

  it('normalises the live connection string without echoing it', () => {
    const normalized = normalizeMySqlUrl(LIVE_URL)
    expect(normalized.ok).toBe(true)
    if (!normalized.ok) return
    // The canonical form is what gets stored: no parameters, port pinned, database present.
    expect(new URL(normalized.url).search).toBe('')
    expect(normalized.url).toContain(':4000/')
    log('normalised host', normalized.host)
    log('database', normalized.database)

    // A rejected string never carries its credentials back
    const rejected = normalizeMySqlUrl(LIVE_URL.replace('@', '@wrong.'))
    expect(rejected.ok).toBe(false)
    const password = new URL(normalized.url).password
    if (!rejected.ok && password) expect(rejected.error).not.toContain(decodeURIComponent(password))
  })

  it('reads the server version through the test-connection path', { timeout: 120_000 }, async () => {
    const normalized = normalizeMySqlUrl(LIVE_URL)
    if (!normalized.ok) throw new Error(normalized.error)
    const result = await testMySqlConnection(normalized.url)
    log('server_version', result.server_version)
    expect(result.server_version).toBeTruthy()
  })

  it('round-trips the documented type mapping and caps the rows', { timeout: 180_000 }, async () => {
    const normalized = normalizeMySqlUrl(LIVE_URL)
    if (!normalized.ok) throw new Error(normalized.error)
    const session = await openMySqlSession(normalized.url)
    try {
      await session.run(`drop table if exists ${table}`, 'write', 5000)
      await session.run(
        `create table ${table} (
           id BIGINT PRIMARY KEY,
           dec_col DECIMAL(12,2),
           dt DATETIME,
           blob_col BLOB,
           doc JSON,
           bits BIT(8),
           flag TINYINT(1)
         )`,
        'write',
        5000
      )
      const insert = await session.run(
        `insert into ${table} values (9007199254740993, 12.34, '2026-11-12 15:39:41', 0x0102, '{"n":1}', b'00000011', 1)`,
        'write',
        5000
      )
      expect(insert.changes).toBe(1)

      const read = await session.run(`select * from ${table}`, 'read', 5000)
      expect(read.truncated).toBe(false)
      const row = read.results[0]!
      log('type row', row)
      log('blob_col hex', hexOfBase64(row.blob_col))
      log('bits hex', hexOfBase64(row.bits))

      // The contract (plan §3.6): BIGINT/DECIMAL as strings, DATETIME as given, JSON as an object,
      // BLOB/BIT as base64, TINYINT(1) as a number.
      expect(typeof row.id).toBe('string')
      expect(row.id).toBe('9007199254740993')
      expect(typeof row.dec_col).toBe('string')
      expect(row.dt).toBe('2026-11-12 15:39:41')
      expect(row.doc).toEqual({ n: 1 })
      expect(row.flag).toBe(1)
      expect(typeof row.blob_col).toBe('string')
      expect(typeof row.bits).toBe('string')

      // Row cap: 5005 rows in one statement, then a read capped at 5000.
      const values = Array.from({ length: 5005 }, (_, i) => `(${i + 1})`).join(',')
      await session.run(`insert into ${table} (id) values ${values}`, 'write', 5000)
      const capped = await session.run(`select id from ${table}`, 'read', 5000)
      log('capped rows', capped.results.length)
      log('capped truncated', capped.truncated)
      expect(capped.results).toHaveLength(5000)
      expect(capped.truncated).toBe(true)

      // A missing table is a statement error, shown to everyone (400 on the route)
      const missing = await session.run('select * from zeta_missing_table_xyz', 'read', 5000).catch((err) => err)
      log('missing table', { kind: missing?.kind, status: missing?.status, message: missing?.message })
      expect(missing).toMatchObject({ kind: 'sql' })
    } finally {
      await session.run(`drop table if exists ${table}`, 'write', 5000).catch(() => {})
      await session.close()
    }
  })

  it('classifies the three failure classes (auth / config / transport)', { timeout: 180_000 }, async () => {
    const normalized = normalizeMySqlUrl(LIVE_URL)
    if (!normalized.ok) throw new Error(normalized.error)
    const parsed = new URL(normalized.url)
    const password = decodeURIComponent(parsed.password)
    const database = parsed.pathname.replace(/^\//, '')

    const withPassword = (next: string) => {
      const url = new URL(normalized.url)
      url.password = next
      return url.toString()
    }
    const withDatabase = (next: string) => {
      const url = new URL(normalized.url)
      url.pathname = `/${next}`
      return url.toString()
    }
    const withHost = (next: string) => {
      const url = new URL(normalized.url)
      url.hostname = next
      return url.toString()
    }

    // Wrong credential → auth, wrong database → config, unreachable gateway → transport.
    // These are the plan's provisional expectations (§3.5); the log line is the re-check evidence.
    const cases = [
      ['auth (wrong password)', withPassword(`${password}-wrong`), 'auth'],
      ['config (wrong database)', withDatabase(`${database}_nope`), 'config'],
      ['transport (unreachable host)', withHost('gateway99.dead-region.prod.aws.tidbcloud.com'), 'transport'],
    ] as const

    for (const [label, url, expected] of cases) {
      const result = await testMySqlConnection(url).then(
        (ok) => ({ ok }),
        (err) => describeMySqlError(err, url, true)
      )
      log(label, {
        kind: 'kind' in result ? result.kind : 'ok',
        message: 'message' in result ? result.message : result.ok,
      })
      if ('kind' in result) {
        expect(result.kind, label).toBe(expected)
        // Whatever the endpoint says, it never repeats the credential
        expect(result.message).not.toContain(password)
      } else {
        // A reachable-but-wrong target must not pass as fine
        expect(result.ok, label).toBeUndefined()
      }
    }
  })

  it('keeps no session state between statements', { timeout: 120_000 }, async () => {
    const normalized = normalizeMySqlUrl(LIVE_URL)
    if (!normalized.ok) throw new Error(normalized.error)
    const session = await openMySqlSession(normalized.url)
    try {
      // The route refuses these two, but the executor itself must show why: nothing carries over.
      await session.run('SET @zeta_live_x = 1', 'write', 5000)
      const read = await session.run('SELECT @zeta_live_x AS x', 'read', 5000)
      log('session variable after SET', read.results[0])
      expect(read.results[0]?.x ?? null).toBeNull()
    } finally {
      await session.close()
    }
  })

  it('sends exactly one HTTP call per batch statement', { timeout: 120_000 }, async () => {
    const normalized = normalizeMySqlUrl(LIVE_URL)
    if (!normalized.ok) throw new Error(normalized.error)
    const original = globalThis.fetch
    let calls = 0
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      calls++
      return original(input, init)
    }) as typeof fetch
    try {
      const session = await openMySqlSession(normalized.url)
      try {
        const afterConnect = calls
        expect(afterConnect).toBe(1) // the `select 1` proof
        for (const sql of ['SELECT 1', 'SELECT 2', 'SELECT 3', 'SELECT 4', 'SELECT 5']) {
          await session.run(sql, 'read', 5000)
        }
        log('fetch calls for 5 statements', calls - afterConnect)
        expect(calls - afterConnect).toBe(5)
      } finally {
        await session.close()
      }
    } finally {
      globalThis.fetch = original
    }
  })
})
