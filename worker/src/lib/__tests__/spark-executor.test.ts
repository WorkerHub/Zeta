import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SparkAccess } from '../spark-access'
import {
  CONNECT_HARD_CAP_MS,
  CONNECT_TEST_OPEN,
  openSparkSession,
  probeSparkHealth,
  QUERY_HEALTH,
  QUERY_TIMEOUT_MS,
  SPARK_APP_TOKEN_MESSAGE,
  SPARK_PUBLISH_TOKEN_MESSAGE,
  SPARK_STARTING_MESSAGE,
  SPARK_STOPPED_MESSAGE,
  testSparkConnection,
  VERIFY_HEALTH,
} from '../spark-executor'

// The published port is replaced by a scripted `fetch`: these tests check what the executor sends
// (URL, both tokens, the JSON body) and what it makes of each failure shape the spike recorded.

const ACCESS: SparkAccess = {
  url: 'https://spark-3f9a.publish.example.dev',
  platform_token: 'platform-token-abc',
  app_token: 'app-token-xyz',
}

const STOPPED_BODY =
  'Sandbox offline: it is stopped, and a visit does not start it. Its owner can start it: instabox start spark'
const DISCONNECTED_BODY = 'The sandbox service disconnected or is unavailable.'
const PRIVATE_BODY =
  'This URL is private. Open the link that carries its ?_token=, or send the token as Authorization: Bearer.'

interface Call {
  url: string
  init: RequestInit
}

const script: Array<() => Response | Promise<Response>> = []
const calls: Call[] = []

const json =
  (body: unknown, status = 200) =>
  () =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const text = (body: string, status: number) => () =>
  new Response(body, { status, headers: { 'content-type': 'text/plain' } })
const fails = (err: unknown) => () => {
  throw err
}

// Small delays keep a retry test instant while still going through the real attempt loop.
const fast = (attempts: number) => ({ delays: Array.from({ length: attempts }, () => 0), budgetMs: 0 })

const healthOk = (version = '3.5.3') => json({ ok: true, sparkVersion: version })
const queryOk = (body: unknown) => json({ rowCount: 0, truncated: false, ...(body as object) })

beforeEach(() => {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} })
    const next = script.shift()
    if (!next) throw new Error(`unexpected fetch: ${String(input)}`)
    return next()
  }) as typeof fetch
})

afterEach(() => {
  script.length = 0
  calls.length = 0
  globalThis.fetch = (() => {
    throw new Error('fetch not scripted')
  }) as typeof fetch
})

describe('probeSparkHealth', () => {
  it('calls /health with the platform token in a header and reads the version', async () => {
    script.push(healthOk())
    await expect(probeSparkHealth(ACCESS)).resolves.toEqual({ sparkVersion: '3.5.3' })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe(`${ACCESS.url}/health`)
    expect(calls[0]!.init.headers).toMatchObject({ Authorization: `Bearer ${ACCESS.platform_token}` })
    // The token never rides in the URL
    expect(calls[0]!.url).not.toContain(ACCESS.platform_token)
    expect(calls[0]!.init.signal).toBeInstanceOf(AbortSignal)
  })

  it('accepts a 200 that is not JSON — /health only has to answer', async () => {
    script.push(text('ok', 200))
    await expect(probeSparkHealth(ACCESS)).resolves.toEqual({ sparkVersion: null })
  })

  it('does not retry a stopped machine: a visit does not start it', async () => {
    script.push(text(STOPPED_BODY, 503))
    const error = await probeSparkHealth(ACCESS, VERIFY_HEALTH).catch((err) => err)
    expect(error).toMatchObject({ kind: 'stopped', code: 'spark_stopped', message: SPARK_STOPPED_MESSAGE })
    // Nine seconds of retries are available, none of them is used
    expect(calls).toHaveLength(1)
  })

  it('retries a booting machine within the policy and gives up with the not-ready sentence', async () => {
    script.push(text(DISCONNECTED_BODY, 502), text(DISCONNECTED_BODY, 502), text(DISCONNECTED_BODY, 502))
    const error = await probeSparkHealth(ACCESS, fast(3)).catch((err) => err)
    expect(error).toMatchObject({ kind: 'starting', code: 'spark_not_ready', message: SPARK_STARTING_MESSAGE })
    expect(calls).toHaveLength(3)
  })

  it('recovers when the machine answers on a later attempt', async () => {
    script.push(text(DISCONNECTED_BODY, 502), healthOk())
    await expect(probeSparkHealth(ACCESS, fast(2))).resolves.toEqual({ sparkVersion: '3.5.3' })
    expect(calls).toHaveLength(2)
  })

  it('never retries a rejected publish token', async () => {
    script.push(text(PRIVATE_BODY, 401))
    const error = await probeSparkHealth(ACCESS, VERIFY_HEALTH).catch((err) => err)
    expect(error).toMatchObject({ kind: 'auth', code: 'spark_publish_token', message: SPARK_PUBLISH_TOKEN_MESSAGE })
    expect(calls).toHaveLength(1)
  })

  it('reports a network failure as transport', async () => {
    script.push(fails(new TypeError('fetch failed')))
    const error = await probeSparkHealth(ACCESS).catch((err) => err)
    expect(error).toMatchObject({ kind: 'transport', code: 'spark_transport' })
  })
})

describe('openSparkSession', () => {
  it('sends one statement with both tokens and maps columns onto objects', async () => {
    script.push(healthOk(), queryOk({ columns: ['a', 'b'], rows: [[1], [2, 3]] }))
    const session = await openSparkSession(ACCESS)
    const result = await session.run('select * from t', 'read', 5000)
    // A short row is padded with null, otherwise its keys would vanish from the JSON
    expect(result).toEqual({
      results: [
        { a: 1, b: null },
        { a: 2, b: 3 },
      ],
      meta: {},
      truncated: false,
    })
    expect(session.sparkVersion).toBe('3.5.3')

    expect(calls[1]!.url).toBe(`${ACCESS.url}/query`)
    expect(calls[1]!.init.method).toBe('POST')
    expect(calls[1]!.init.headers).toMatchObject({
      Authorization: `Bearer ${ACCESS.platform_token}`,
      'X-Auth-Token': ACCESS.app_token,
      'Content-Type': 'application/json',
    })
    expect(JSON.parse(String(calls[1]!.init.body))).toEqual({ sql: 'select * from t', maxRows: 5000 })
    // Never wrapped in a LIMIT: the service caps at 5000 and reports `truncated` itself
    expect(String(calls[1]!.init.body)).not.toContain('zeta_limit')
  })

  it('passes truncated through, whether the cap was reached or not', async () => {
    script.push(healthOk(), queryOk({ columns: ['n'], rows: [[1], [2]], truncated: true }))
    const session = await openSparkSession(ACCESS)
    await expect(session.run('select n from t', 'read', 2)).resolves.toMatchObject({ truncated: true })
  })

  it('returns no result rows and no affected-row count for a write', async () => {
    script.push(healthOk(), queryOk({ columns: [], rows: [], rowCount: 0 }))
    const session = await openSparkSession(ACCESS)
    const result = await session.run('insert into t select 1', 'write', 5000)
    // The service reports 0 for DDL/DML; an affected-row count is never invented
    expect(result).toEqual({ results: [], meta: {}, truncated: false })
    expect(calls[1]!.init.body).toContain('insert into t select 1')
  })

  it('never retries a statement, even when the machine goes away mid-flight', async () => {
    script.push(healthOk(), text(STOPPED_BODY, 503))
    const session = await openSparkSession(ACCESS)
    const error = await session.run('select 1', 'read', 1).catch((err) => err)
    expect(error).toMatchObject({ kind: 'stopped', code: 'spark_stopped' })
    expect(calls).toHaveLength(2)
  })

  it('turns 200 + {"error"} into a sql failure shown verbatim (trimmed)', async () => {
    const detail = '[TABLE_OR_VIEW_NOT_FOUND] The table or view `zeta.nope` cannot be found.'
    script.push(healthOk(), json({ error: detail }))
    const session = await openSparkSession(ACCESS)
    const error = await session.run('select * from nope', 'read', 5000).catch((err) => err)
    expect(error).toMatchObject({ kind: 'sql', code: 'spark_sql', message: detail })
  })

  it('turns 400 {"error":"empty sql"} into a sql failure as well', async () => {
    script.push(healthOk(), json({ error: 'empty sql' }, 400))
    const session = await openSparkSession(ACCESS)
    const error = await session.run('select 1', 'read', 5000).catch((err) => err)
    expect(error).toMatchObject({ kind: 'sql', code: 'spark_sql', message: 'empty sql' })
  })

  it('tells the rejected layers apart by content type', async () => {
    // The service rejects the application token with JSON…
    script.push(healthOk(), json({ error: 'unauthorized' }, 401))
    const session = await openSparkSession(ACCESS)
    const app = await session.run('select 1', 'read', 1).catch((err) => err)
    expect(app).toMatchObject({ kind: 'auth', code: 'spark_app_token', message: SPARK_APP_TOKEN_MESSAGE })

    // …the publish proxy with plain text
    script.length = 0
    calls.length = 0
    script.push(healthOk(), text(PRIVATE_BODY, 401))
    const second = await openSparkSession(ACCESS)
    const publish = await second.run('select 1', 'read', 1).catch((err) => err)
    expect(publish).toMatchObject({ kind: 'auth', code: 'spark_publish_token', message: SPARK_PUBLISH_TOKEN_MESSAGE })
    expect(calls).toHaveLength(2)
  })

  it('classifies a 403 as a token rejection and other 5xx as transport', async () => {
    script.push(healthOk(), text('forbidden by the proxy', 403))
    const session = await openSparkSession(ACCESS)
    expect(await session.run('select 1', 'read', 1).catch((e) => e)).toMatchObject({
      kind: 'auth',
      code: 'spark_publish_token',
    })

    script.push(healthOk(), text('boom', 500))
    const second = await openSparkSession(ACCESS)
    expect(await second.run('select 1', 'read', 1).catch((e) => e)).toMatchObject({
      kind: 'transport',
      code: 'spark_transport',
    })
  })

  it('rejects a 200 that is not the JSON contract', async () => {
    script.push(healthOk(), text('<html>nope</html>', 200))
    const session = await openSparkSession(ACCESS)
    const error = await session.run('select 1', 'read', 1).catch((err) => err)
    expect(error).toMatchObject({ kind: 'transport', code: 'spark_transport' })
  })

  it('reports a lost connection as transport', async () => {
    script.push(healthOk(), fails(new TypeError('fetch failed')))
    const session = await openSparkSession(ACCESS)
    const error = await session.run('select 1', 'read', 1).catch((err) => err)
    expect(error).toMatchObject({ kind: 'transport', code: 'spark_transport' })
  })

  it('redacts the URL and both tokens and cuts the detail at 1500 characters', async () => {
    const leaked = `failure at ${ACCESS.url} token ${ACCESS.app_token} platform ${ACCESS.platform_token} ${'x'.repeat(4000)}`
    script.push(healthOk(), json({ error: leaked }))
    const session = await openSparkSession(ACCESS)
    const error = await session.run('select 1', 'read', 1).catch((err) => err)
    expect(error.kind).toBe('sql')
    expect(error.message).not.toContain(ACCESS.url)
    expect(error.message).not.toContain(ACCESS.app_token)
    expect(error.message).not.toContain(ACCESS.platform_token)
    expect(error.message).toContain('[redacted]')
    expect(error.message.length).toBeLessThanOrEqual(1500)
  })
})

describe('budgets', () => {
  it('keeps the query path short and the connection check patient', () => {
    expect(QUERY_TIMEOUT_MS).toBe(300_000)
    expect(CONNECT_HARD_CAP_MS).toBe(120_000)
    expect(CONNECT_TEST_OPEN).toEqual({ health: VERIFY_HEALTH, hardCapMs: CONNECT_HARD_CAP_MS })
    expect(QUERY_HEALTH.delays).toEqual([0, 800, 2400])
    // ~17.6 s of attempts, comfortably past the ~17 s a machine needs to boot
    expect(VERIFY_HEALTH.budgetMs).toBe(20_000)
    expect(VERIFY_HEALTH.delays.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(17_000)
    expect(VERIFY_HEALTH.delays.length).toBeGreaterThan(QUERY_HEALTH.delays.length)
  })

  it('lets a connection check outlast the query budget and still succeed', async () => {
    const patient = { ...VERIFY_HEALTH, delays: [0, 0, 0, 0, 0] }
    script.push(text(DISCONNECTED_BODY, 502), text(DISCONNECTED_BODY, 502), text(DISCONNECTED_BODY, 502))
    script.push(text(DISCONNECTED_BODY, 502), healthOk(), queryOk({ columns: ['ok'], rows: [[1]] }))
    const session = await openSparkSession(ACCESS, { ...CONNECT_TEST_OPEN, health: patient })
    await expect(session.run('select 1', 'read', 1)).resolves.toMatchObject({ results: [{ ok: 1 }] })
    expect(calls).toHaveLength(6)
  })

  it('refuses to start a statement once the hard cap has passed', async () => {
    script.push(healthOk())
    const session = await openSparkSession(ACCESS, { hardCapMs: 1 })
    await new Promise((resolve) => setTimeout(resolve, 5))
    const error = await session.run('select 1', 'read', 1).catch((err) => err)
    expect(error).toMatchObject({ kind: 'starting', code: 'spark_not_ready', message: SPARK_STARTING_MESSAGE })
    expect(calls).toHaveLength(1)
  })
})

describe('testSparkConnection', () => {
  it('runs /health and one statement, then reports the version', async () => {
    script.push(healthOk('3.5.3'), queryOk({ columns: ['ok'], rows: [[1]] }))
    await expect(testSparkConnection(ACCESS)).resolves.toEqual({ server_version: '3.5.3' })
    expect(calls.map((c) => c.url)).toEqual([`${ACCESS.url}/health`, `${ACCESS.url}/query`])
    expect(JSON.parse(String(calls[1]!.init.body))).toEqual({ sql: 'select 1', maxRows: 1 })
  })

  it('fails on a health-only answer, because an application token is not proven by it', async () => {
    // /health passes with only the platform token; the statement is what rejects a bad app token
    script.push(healthOk(), json({ error: 'unauthorized' }, 401))
    await expect(testSparkConnection(ACCESS)).rejects.toMatchObject({ code: 'spark_app_token' })
  })
})
