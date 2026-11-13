import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  describeMySqlError,
  MySqlQueryError,
  openMySqlSession,
  REQUEST_TIMEOUT_MS,
  testMySqlConnection,
} from '../mysql-executor'

// The official driver is replaced by a scripted one: these tests check what the executor asks of it
// (statement text, fullResult, one connection per session) and what it makes of the answers.

interface QueueEntry {
  rows?: unknown[] | null
  rowsAffected?: number | null
  error?: unknown
}

const driver = vi.hoisted(() => ({
  connects: [] as Array<{ url: string; config: Record<string, unknown> }>,
  queue: [] as QueueEntry[],
  connectError: null as unknown,
  executes: [] as Array<{ sql: string; options: unknown }>,
}))

vi.mock('@tidbcloud/serverless', () => ({
  connect: (config: Record<string, unknown>) => {
    driver.connects.push({ url: String(config.url), config })
    if (driver.connectError) {
      const pending = driver.connectError
      driver.connectError = null
      throw pending
    }
    return {
      async execute(sql: string, _args: unknown, options: unknown) {
        driver.executes.push({ sql, options })
        const next = driver.queue.shift()
        if (next?.error) throw next.error
        return {
          statement: sql,
          types: {},
          rows: next?.rows ?? null,
          rowsAffected: next?.rowsAffected ?? null,
          lastInsertId: null,
          rowCount: next?.rows?.length ?? 0,
        }
      },
    }
  },
}))

const URL = 'mysql://3Kx9aBcD.root:p%40ss@gateway01.us-east-1.prod.aws.tidbcloud.com:4000/zeta'
const PASSWORD = 'p@ss'
const HOST = 'gateway01.us-east-1.prod.aws.tidbcloud.com'

// A driver-shaped failure: status + details, message as the endpoint sent it.
function dbError(message: string, status: number, code = '') {
  const err = new Error(message) as Error & { status: number; details: unknown }
  err.status = status
  err.details = code ? { code, message } : null
  return err
}

// Every session proves itself with `select 1` first, so each test seeds that answer before its own.
function seed(...entries: QueueEntry[]) {
  driver.queue.push({ rows: [{ '1': 1 }] }, ...entries)
}

afterEach(() => {
  driver.connects.length = 0
  driver.queue.length = 0
  driver.connectError = null
  driver.executes.length = 0
})

describe('openMySqlSession', () => {
  it('proves the connection with select 1 and the session database before running anything else', async () => {
    seed()
    await openMySqlSession(URL)
    expect(driver.connects).toHaveLength(1)
    expect(driver.connects[0]!.url).toBe(URL)
    expect(driver.executes.map((e) => e.sql)).toEqual(['select 1 as ok, database() as db'])
  })

  it('fails closed when the instance session points at another database', async () => {
    // The endpoint keeps one session per (credentials, database) and reuses it, so a `USE` issued
    // elsewhere would otherwise route our statements into the wrong schema.
    driver.queue.push({ rows: [{ ok: 1, db: 'somewhere_else' }] })
    await expect(openMySqlSession(URL)).rejects.toMatchObject({ kind: 'config' })
    expect(driver.executes).toHaveLength(1)
  })

  it('accepts a session already on the registered database', async () => {
    driver.queue.push({ rows: [{ ok: 1, db: 'zeta' }] })
    const session = await openMySqlSession(URL)
    expect(driver.executes).toHaveLength(1)
    await session.close()
  })

  it('runs a read through the row cap with a MySQL subquery alias', async () => {
    seed({ rows: [{ id: 1 }] })
    const session = await openMySqlSession(URL)
    const result = await session.run('SELECT * FROM t', 'read', 5000)
    expect(result).toEqual({ results: [{ id: 1 }], meta: {}, truncated: false })
    expect(driver.executes[1]).toEqual({
      sql: 'SELECT * FROM (\nSELECT * FROM t\n) AS zeta_limit LIMIT 5001',
      options: { fullResult: true },
    })
  })

  it('leaves a locking read unwrapped and cuts its output afterwards', async () => {
    seed({ rows: [{ id: 1 }, { id: 2 }] })
    const session = await openMySqlSession(URL)
    const result = await session.run('SELECT * FROM t FOR UPDATE', 'read', 1)
    expect(driver.executes[1]!.sql).toBe('SELECT * FROM t FOR UPDATE')
    expect(result.results).toHaveLength(1)
    expect(result.truncated).toBe(true)
  })

  it('returns the affected row count for a write and no result rows', async () => {
    seed({ rowsAffected: 3 })
    const session = await openMySqlSession(URL)
    const result = await session.run('DELETE FROM t', 'write', 5000)
    expect(result).toEqual({ results: [], meta: { changes: 3 }, changes: 3, truncated: false })
    // A write is sent as written: nothing is wrapped in a LIMIT
    expect(driver.executes[1]!.sql).toBe('DELETE FROM t')
  })

  it('maps driver values to JSON-safe ones (BLOB bytes to base64)', async () => {
    seed({ rows: [{ n: 1, big: '9007199254740993', blob: new Uint8Array([1, 2]), at: null }] })
    const session = await openMySqlSession(URL)
    const result = await session.run('SELECT * FROM t', 'read', 5000)
    expect(result.results[0]).toEqual({ n: 1, big: '9007199254740993', blob: 'AQI=', at: null })
  })

  it('reuses one driver connection for every statement of a session', async () => {
    seed({ rows: [{ n: 1 }] }, { rows: [{ n: 2 }] })
    const session = await openMySqlSession(URL)
    await session.run('SELECT 1', 'read', 5000)
    await session.run('SELECT 2', 'read', 5000)
    expect(driver.connects).toHaveLength(1)
    await session.close()
    expect(driver.connects).toHaveLength(1)
  })

  it('reports a failed connect proof as a transport error', async () => {
    driver.connectError = dbError('fetch failed', 0)
    await expect(openMySqlSession(URL)).rejects.toMatchObject({ kind: 'transport' })
    expect(driver.executes).toHaveLength(0)
  })
})

describe('describeMySqlError', () => {
  it('classifies a rejected statement (status 400 with an errno line) as sql', () => {
    const err = dbError("Execute SQL fail: Error 1146 (42S02): Table 'zeta.missing' doesn't exist", 400, '61100002')
    expect(describeMySqlError(err)).toMatchObject({ kind: 'sql' })
  })

  it('classifies a parser error, which carries no errno line, as sql too', () => {
    // Live shape (plan §10-6): `You have an error in your SQL syntax: line 1 column 5 near "SELEC 1"`
    const err = dbError('You have an error in your SQL syntax: line 1 column 5 near "SELEC 1" ', 400, '400')
    expect(describeMySqlError(err).kind).toBe('sql')
  })

  it('classifies 1105 as sql (finalized by the live re-check)', () => {
    const err = dbError('Error 1105 (HY000): context deadline exceeded', 400)
    expect(describeMySqlError(err).kind).toBe('sql')
  })

  it('classifies an unknown database as config, even though it arrives as 401', () => {
    // Live shape: `Error 1049 (42000): Unknown database 'nope'` with status 401
    const err = dbError("Error 1049 (42000): Unknown database 'nope'", 401)
    const described = describeMySqlError(err)
    expect(described.kind).toBe('config')
    expect(described.message).toContain('does not exist')
    expect(described.message).not.toContain('Authentication')
  })

  it('classifies rejected credentials as auth', () => {
    for (const status of [401, 403]) {
      const err = dbError(`Error 1105 (HY000): Access denied for user 'x'`, status)
      expect(describeMySqlError(err).kind).toBe('auth')
    }
  })

  it('classifies quota/rate limiting and server errors as transport', () => {
    expect(describeMySqlError(dbError('rate limited', 429)).kind).toBe('transport')
    expect(describeMySqlError(dbError('boom', 502)).kind).toBe('transport')
    expect(describeMySqlError(dbError('empty session, please try again', 500)).kind).toBe('transport')
  })

  it('classifies a fetch failure during connect as transport', () => {
    expect(describeMySqlError(new TypeError('fetch failed'), '', true).kind).toBe('transport')
  })

  it('classifies unencodable credentials as config', () => {
    const err = new Error('The string to be encoded contains characters outside of the Latin1 range.')
    expect(describeMySqlError(err).kind).toBe('config')
  })

  it('passes an already classified error through untouched', () => {
    const err = new MySqlQueryError('nope', 'config')
    expect(describeMySqlError(err)).toBe(err)
  })

  it('redacts the URL, its host and its credential from the message', () => {
    const err = dbError(`cannot reach ${URL} (${HOST}) with ${PASSWORD}`, 400)
    const described = describeMySqlError(err, URL)
    expect(described.message).not.toContain('p@ss')
    expect(described.message).not.toContain(HOST)
    expect(described.message).not.toContain(URL)
    expect(described.message).toContain('[redacted]')
  })
})

describe('driver fetch hook', () => {
  it('bounds every HTTP call with the platform timeout signal', async () => {
    const original = globalThis.fetch
    const calls: Array<{ input: string; init?: RequestInit }> = []
    globalThis.fetch = (async (input: string, init?: RequestInit) => {
      calls.push({ input, init })
      return new Response('{}', { status: 200 })
    }) as typeof fetch
    try {
      seed()
      await openMySqlSession(URL)
      const hook = driver.connects[0]!.config.fetch as (input: string, init?: RequestInit) => Promise<unknown>
      expect(typeof hook).toBe('function')
      await hook('https://http-gateway.example/v1beta/sql', { method: 'POST', body: '{}' })
      expect(calls).toHaveLength(1)
      expect(calls[0]!.input).toBe('https://http-gateway.example/v1beta/sql')
      expect(calls[0]!.init?.signal).toBeInstanceOf(AbortSignal)
      expect(REQUEST_TIMEOUT_MS).toBe(30_000)
    } finally {
      globalThis.fetch = original
    }
  })
})

describe('testMySqlConnection', () => {
  it('reads the server version and closes the session', async () => {
    seed({ rows: [{ version: '8.0.11-TiDB-v8.5.3' }] })
    const result = await testMySqlConnection(URL)
    expect(result).toEqual({ server_version: '8.0.11-TiDB-v8.5.3' })
    expect(driver.executes[1]!.sql).toBe('SELECT * FROM (\nselect version()\n) AS zeta_limit LIMIT 2')
  })
})
