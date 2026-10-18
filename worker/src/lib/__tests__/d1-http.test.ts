import { describe, it, expect, afterEach, vi } from 'vitest'
import type { Env } from '../../types'
import { listAccountD1Databases, queryD1Http, D1HttpError } from '../d1-http'

const APP_DB = '11111111-1111-4111-8111-111111111111'
const DB_1 = '22222222-2222-4222-8222-222222222222'

const env = (overrides: Partial<Env> = {}) =>
  ({ CF_ACCOUNT_ID: 'acct123', CF_D1_API_TOKEN: 'tok', ZETA_APP_DB_ID: APP_DB, ...overrides }) as unknown as Env

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

afterEach(() => vi.unstubAllGlobals())

describe('listAccountD1Databases', () => {
  it('returns the account databases minus the application database', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        success: true,
        result: [
          { uuid: APP_DB, name: 'zeta', created_at: 'x' },
          { uuid: DB_1, name: 'analytics', created_at: 'y' },
          { uuid: '33333333-3333-4333-8333-333333333333', name: 'logs', created_at: 'z' },
        ],
        result_info: { page: 1, per_page: 100, total_count: 3 },
      })
    )
    vi.stubGlobal('fetch', fetchMock)
    const rows = await listAccountD1Databases(env())
    expect(rows.map((r) => r.uuid)).toEqual([DB_1, '33333333-3333-4333-8333-333333333333'])
    expect(String(fetchMock.mock.calls[0]![0])).toContain('/accounts/acct123/d1/database?page=1&per_page=100')
  })

  it('paginates until every page has been fetched', async () => {
    const makeRows = (start: number, n: number) =>
      Array.from({ length: n }, (_, i) => ({ uuid: `db-${start + i}`, name: `db-${start + i}`, created_at: 'x' }))
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          success: true,
          result: [{ uuid: APP_DB, name: 'zeta', created_at: 'x' }, ...makeRows(1, 99)],
          result_info: { page: 1, per_page: 100, total_count: 250 },
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          success: true,
          result: makeRows(101, 100),
          result_info: { page: 2, per_page: 100, total_count: 250 },
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          success: true,
          result: makeRows(201, 50),
          result_info: { page: 3, per_page: 100, total_count: 250 },
        })
      )
    vi.stubGlobal('fetch', fetchMock)
    const rows = await listAccountD1Databases(env())
    expect(rows).toHaveLength(249) // 250 account databases minus the app DB
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('fails closed when ZETA_APP_DB_ID is missing', async () => {
    vi.stubGlobal('fetch', vi.fn())
    await expect(listAccountD1Databases(env({ ZETA_APP_DB_ID: '' }))).rejects.toMatchObject({
      kind: 'config',
      status: 500,
    })
  })

  it('maps an invalid token to an auth error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ success: false, errors: [{ code: 10000, message: 'bad token' }] }, 403))
    )
    await expect(listAccountD1Databases(env())).rejects.toMatchObject({ kind: 'auth', status: 500 })
  })

  it('maps 429 to a rate-limit error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ success: false, errors: [{ code: 10000, message: 'slow down' }] }, 429))
    )
    await expect(listAccountD1Databases(env())).rejects.toMatchObject({ kind: 'rate_limit', status: 429 })
  })

  it('fails closed when ZETA_APP_DB_ID is not a database in the account', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({
          success: true,
          result: [{ uuid: DB_1, name: 'analytics', created_at: 'x' }],
          result_info: { page: 1, per_page: 100, total_count: 1 },
        })
      )
    )
    await expect(listAccountD1Databases(env())).rejects.toMatchObject({
      kind: 'config',
      status: 500,
      message: 'ZETA_APP_DB_ID is not a database in this Cloudflare account.',
    })
  })

  it('treats a trailing-newline ZETA_APP_DB_ID as the app DB', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({
          success: true,
          result: [{ uuid: APP_DB, name: 'zeta', created_at: 'x' }],
          result_info: { page: 1, per_page: 100, total_count: 1 },
        })
      )
    )
    const rows = await listAccountD1Databases(env({ ZETA_APP_DB_ID: `${APP_DB}\n` }))
    expect(rows).toEqual([])
  })
})

describe('queryD1Http', () => {
  it('normalises a result row and its meta changes', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({
          success: true,
          result: [{ success: true, results: [{ id: 1 }], meta: { changes: 2, duration: 0.1 } }],
        })
      )
    )
    const res = await queryD1Http(env(), DB_1, 'SELECT 1')
    expect(res.results).toEqual([{ id: 1 }])
    expect(res.changes).toBe(2)
    expect(res.meta).toMatchObject({ changes: 2 })
  })

  it('sends the statement as the sql body and posts to the query endpoint', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ success: true, result: [{ success: true, results: [], meta: {} }] }))
    vi.stubGlobal('fetch', fetchMock)
    await queryD1Http(env(), DB_1, 'SELECT 1')
    const [url, init] = fetchMock.mock.calls[0]!
    expect(String(url)).toBe(`https://api.cloudflare.com/client/v4/accounts/acct123/d1/database/${DB_1}/query`)
    expect(JSON.parse(String(init!.body))).toEqual({ sql: 'SELECT 1' })
  })

  it('surfaces a failed statement as a sql error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({
          success: true,
          errors: [{ code: 7500, message: 'no such table: x' }],
          result: [{ success: false }],
        })
      )
    )
    await expect(queryD1Http(env(), DB_1, 'SELECT * FROM x')).rejects.toMatchObject({
      kind: 'sql',
      message: 'no such table: x',
    })
  })

  it('maps a network failure to a transport error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')))
    await expect(queryD1Http(env(), DB_1, 'SELECT 1')).rejects.toBeInstanceOf(D1HttpError)
    await expect(queryD1Http(env(), DB_1, 'SELECT 1')).rejects.toMatchObject({ kind: 'transport', status: 500 })
  })

  it('maps an aborted/timeout request to a transport error', async () => {
    const abort = new Error('The operation was aborted due to timeout')
    abort.name = 'AbortError'
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(abort))
    await expect(queryD1Http(env(), DB_1, 'SELECT 1')).rejects.toMatchObject({
      kind: 'transport',
      status: 500,
      message: 'Cloudflare API request timed out.',
    })
  })

  it('fails closed when credentials are missing', async () => {
    vi.stubGlobal('fetch', vi.fn())
    await expect(queryD1Http(env({ CF_D1_API_TOKEN: '' }), DB_1, 'SELECT 1')).rejects.toMatchObject({
      kind: 'config',
      status: 500,
    })
  })
})
