import { describe, expect, it } from 'vitest'
import { describeMySqlError, openMySqlSession, testMySqlConnection } from '../mysql-executor'
import { normalizeMySqlUrl } from '../mysql-url'

// Opt-in live test: runs only when a real TiDB Cloud Starter connection string is provided in the
// environment (team secret, never committed). It walks the re-check list of the phase-2 plan (§10):
// normalisation, server version, the type mapping (BLOB/BIT byte-for-byte), the 5000-row cap, the
// three failure classes, the session semantics and one HTTP call per batch statement.
//
//   TIDB_URL=… pnpm test -- mysql-live
//
// Everything it prints is prefixed `[mysql-live]` so the evidence can be pasted into the delivery
// report. It creates and drops its own table and touches nothing else.
const LIVE_URL = process.env.TIDB_URL ?? ''

// A free instance's fixture URL may point at a system schema without DDL rights (this one points at
// `sys`), so the write tests look for a database this user can create a table in: the string's own
// database first, then `test`, which TiDB Cloud Starter grants to every instance user.
async function writableUrl(base: string): Promise<string> {
  const parsed = new URL(base)
  const own = parsed.pathname.replace(/^\//, '')
  const candidates = own && own !== 'test' ? [own, 'test'] : ['test']
  const errors: string[] = []
  for (const database of candidates) {
    const url = new URL(base)
    url.pathname = `/${database}`
    const session = await openMySqlSession(url.toString()).catch((err) => {
      errors.push(`${database}: ${describeMySqlError(err).message}`)
      return null
    })
    if (!session) continue
    try {
      await session.run('CREATE TABLE IF NOT EXISTS zeta_live_probe (id INT PRIMARY KEY)', 'write', 5000)
      await session.run('DROP TABLE zeta_live_probe', 'write', 5000)
      return url.toString()
    } catch (err) {
      errors.push(`${database}: ${describeMySqlError(err).message}`)
    } finally {
      await session.close()
    }
  }
  throw new Error(`no writable database on this instance (${errors.join(' | ')})`)
}

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

    // The stored form is a fixed point: normalising it again changes nothing.
    const again = normalizeMySqlUrl(normalized.url)
    expect(again.ok && again.url).toBe(normalized.url)

    // A string for another host is refused, and the message never carries the credential back.
    const password = decodeURIComponent(new URL(normalized.url).password)
    const elsewhere = new URL(normalized.url)
    elsewhere.hostname = 'db.example.com'
    const rejected = normalizeMySqlUrl(elsewhere.toString())
    expect(rejected.ok).toBe(false)
    if (!rejected.ok && password) expect(rejected.error).not.toContain(password)
  })

  it('reads the server version through the test-connection path', { timeout: 120_000 }, async () => {
    const normalized = normalizeMySqlUrl(LIVE_URL)
    if (!normalized.ok) throw new Error(normalized.error)
    const result = await testMySqlConnection(normalized.url)
    log('server_version', result.server_version)
    expect(result.server_version).toBeTruthy()
  })

  it('round-trips the documented type mapping and caps the rows', { timeout: 180_000 }, async () => {
    const normalized = normalizeMySqlUrl(await writableUrl(LIVE_URL))
    if (!normalized.ok) throw new Error(normalized.error)
    log('type test database', normalized.database)
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
      // §10-3, finalized: the bytes match what was written — no extra leading 0x00 on BLOB or BIT.
      expect(hexOfBase64(row.blob_col)).toBe('0102')
      expect(hexOfBase64(row.bits)).toBe('03')

      // Row cap: 5005 rows in one statement, then a read capped at 5000.
      const values = Array.from({ length: 5005 }, (_, i) => `(${i + 1})`).join(',')
      await session.run(`insert into ${table} (id) values ${values}`, 'write', 5000)
      const capped = await session.run(`select id from ${table}`, 'read', 5000)
      log('capped rows', capped.results.length)
      log('capped truncated', capped.truncated)
      expect(capped.results).toHaveLength(5000)
      expect(capped.truncated).toBe(true)

      // §10-6: statement errors arrive as 400 and are shown to everyone.
      const missing = await session.run('select * from zeta_missing_table_xyz', 'read', 5000).catch((err) => err)
      log('missing table', { kind: missing?.kind, message: missing?.message })
      expect(missing).toMatchObject({ kind: 'sql' })
      const syntax = await session.run('SELEC 1', 'read', 5000).catch((err) => err)
      log('syntax error', { kind: syntax?.kind, message: syntax?.message })
      expect(syntax).toMatchObject({ kind: 'sql' })
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

    const withpassword = (next: string) => {
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

    // Wrong credential → auth, wrong database → config (the endpoint answers 401 + Error 1049 for it),
    // unreachable gateway → transport. This is the §10-5 conclusion, recorded in the log line.
    const cases = [
      ['auth (wrong password)', withpassword(`${password}-wrong`), 'auth'],
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

  it('records that the endpoint keeps one session per credentials (§10-7)', { timeout: 120_000 }, async () => {
    const normalized = normalizeMySqlUrl(LIVE_URL)
    if (!normalized.ok) throw new Error(normalized.error)
    const first = await openMySqlSession(normalized.url)
    try {
      // The route refuses `SET` (lib/sql-guard.ts), but the executor itself shows what the endpoint
      // does: a user variable set here is visible from a *fresh* driver connection afterwards.
      await first.run('SET @zeta_live_shared = 1', 'write', 5000)
      const second = await openMySqlSession(normalized.url)
      try {
        const read = await second.run('SELECT @zeta_live_shared AS v', 'read', 5000)
        log('user variable from a fresh connection', read.results[0])
        expect(read.results[0]?.v).toBe('1')
      } finally {
        await second.close()
      }
    } finally {
      // Leave the shared session as it was found.
      await first.run('SET @zeta_live_shared := NULL', 'write', 5000).catch(() => {})
      await first.close()
    }
  })

  it('pins the registered database again for every session, whatever a previous USE did', {
    timeout: 120_000,
  }, async () => {
    const normalized = normalizeMySqlUrl(LIVE_URL)
    if (!normalized.ok) throw new Error(normalized.error)
    const expected = normalized.database
    const elsewhere = expected === 'test' ? 'mysql' : 'test'
    const first = await openMySqlSession(normalized.url)
    try {
      const used = await first
        .run(`USE \`${elsewhere}\``, 'read', 5000)
        .then(() => true)
        .catch(() => false)
      if (!used) {
        log('this instance refused USE, nothing to drift to', elsewhere)
        return
      }
      const drifted = await first.run('SELECT database() AS db', 'read', 5000)
      log('session database after USE', drifted.results[0])
      expect(drifted.results[0]?.db).toBe(elsewhere)
    } finally {
      // Leave the shared session as it was found.
      await first.run(`USE \`${expected}\``, 'read', 5000).catch(() => {})
      await first.close()
    }
    // A fresh session must start on the registered database, not where the previous one stopped.
    const second = await openMySqlSession(normalized.url)
    try {
      const pinned = await second.run('SELECT database() AS db', 'read', 5000)
      log('session database of a fresh session', pinned.results[0])
      expect(pinned.results[0]?.db).toBe(expected)
    } finally {
      await second.close()
    }
  })

  it('pins the database the request chose for its session, in every later request too', {
    timeout: 180_000,
  }, async () => {
    const normalized = normalizeMySqlUrl(LIVE_URL)
    if (!normalized.ok) throw new Error(normalized.error)
    const registered = normalized.database

    // The session can only be pinned to a schema this instance actually has, so the candidates are
    // read from the server rather than guessed, and the registered one is skipped to keep the check
    // meaningful (a fresh instance may expose no other schema — then there is nothing to prove here).
    const system = new Set(['information_schema', 'mysql', 'performance_schema', 'sys', 'metrics_schema'])
    const listing = await openMySqlSession(normalized.url)
    let candidates: string[] = []
    try {
      const rows = await listing.run('SELECT schema_name AS db FROM information_schema.schemata', 'read', 5000)
      candidates = rows.results
        .map((row) => String(row.db ?? ''))
        // `schemata` reports a system schema in upper case
        .filter((db) => db && db !== registered && !system.has(db.toLowerCase()))
    } finally {
      await listing.close()
    }

    let chosen: string | null = null
    for (const db of candidates) {
      const probe = await openMySqlSession(normalized.url, db).catch(() => null)
      if (!probe) continue
      await probe.run(`USE \`${registered}\``, 'read', 5000).catch(() => {})
      await probe.close()
      chosen = db
      break
    }
    if (!chosen) {
      log('this instance exposes no second schema to pin', candidates)
      return
    }

    // Request 1: pins the chosen schema instead of the registered one
    const first = await openMySqlSession(normalized.url, chosen)
    try {
      const read = await first.run('SELECT database() AS db', 'read', 5000)
      log('session database chosen by the request', read.results[0])
      expect(read.results[0]?.db).toBe(chosen)
    } finally {
      await first.run(`USE \`${registered}\``, 'read', 5000).catch(() => {})
      await first.close()
    }

    // Request 2, in a new session: the same choice still decides where it starts
    const second = await openMySqlSession(normalized.url, chosen)
    try {
      const again = await second.run('SELECT database() AS db', 'read', 5000)
      log('session database of a later request that chose it', again.results[0])
      expect(again.results[0]?.db).toBe(chosen)
    } finally {
      await second.run(`USE \`${registered}\``, 'read', 5000).catch(() => {})
      await second.close()
    }

    // A request without the field starts on the registered database again
    const third = await openMySqlSession(normalized.url)
    try {
      const pinned = await third.run('SELECT database() AS db', 'read', 5000)
      log('session database without the field', pinned.results[0])
      expect(pinned.results[0]?.db).toBe(registered)
    } finally {
      await third.close()
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
        expect(afterConnect).toBe(1) // the statement that pins the registered database
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
