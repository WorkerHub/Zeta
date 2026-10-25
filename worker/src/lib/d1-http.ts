import type { Env } from '../types'

// ── Cloudflare D1 HTTP API client ──────────────────────────────────────────────
// Query targets are reached over the REST API instead of Worker bindings, so adding a database
// no longer needs a binding or a redeploy. Everything the SQL editor can run still goes through
// sql-guard first (classification, permission, single-statement, 5000-row cap) — this module only
// transports an already-validated statement and maps the API's responses/errors.

const CF_API_BASE = 'https://api.cloudflare.com/client/v4'
const REQUEST_TIMEOUT_MS = 30_000
const LIST_PER_PAGE = 100

// 'sql' and 'rate_limit' are safe to show to any caller; the rest are deployment details that only
// admins should see (the route decides the member-facing wording).
export type D1HttpErrorKind = 'config' | 'auth' | 'rate_limit' | 'transport' | 'sql'

export class D1HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly kind: D1HttpErrorKind = 'transport'
  ) {
    super(message)
  }
}

export interface CfD1Database {
  uuid: string
  name: string
  created_at: string
}

export interface D1QueryResult {
  results: Record<string, unknown>[]
  meta: Record<string, unknown>
  changes: number
}

interface CfResponse<T> {
  success?: boolean
  errors?: Array<{ code?: number; message?: string }>
  result?: T
  result_info?: { page?: number; per_page?: number; total_count?: number; count?: number }
}

function accountAndToken(env: Env): { accountId: string; token: string } {
  const accountId = env.CF_ACCOUNT_ID?.trim()
  const token = env.CLOUDFLARE_API_TOKEN?.trim()
  if (!accountId) throw new D1HttpError(500, 'CF_ACCOUNT_ID is not configured on this Worker.', 'config')
  if (!token) throw new D1HttpError(500, 'CLOUDFLARE_API_TOKEN is not configured on this Worker.', 'config')
  return { accountId, token }
}

// The application database's UUID, trimmed so a value pasted with a trailing newline still matches
// the uuid stored on registry rows. Used by every app-DB exclusion check, so they all compare the
// same normalised string.
export function appDbId(env: Env): string | undefined {
  const v = env.ZETA_APP_DB_ID?.trim()
  return v ? v : undefined
}

// The opt-in switch for using the application database itself as a query target (shared-database
// deployments). Only the exact value "true" (case-insensitive, surrounding whitespace ignored)
// turns it on; unset, empty or any other value stays off — fail closed. This is the single place
// every exclusion point and guardrail reads the env var from; no other code may read it directly.
export function appDbTargetAllowed(env: Env): boolean {
  return env.ALLOW_APP_DB_AS_TARGET?.trim().toLowerCase() === 'true'
}

// The single target-identity check shared by every exclusion/annotation point: does this
// cf_database_id refer to the application's own database? Callers must NOT re-implement the
// comparison against appDbId() themselves.
export function isAppDb(env: Env, cfDatabaseId: string | null | undefined): boolean {
  const appId = appDbId(env)
  return appId !== undefined && cfDatabaseId === appId
}

async function cfFetch(env: Env, path: string, init: RequestInit = {}): Promise<Response> {
  const { token } = accountAndToken(env)
  try {
    return await fetch(`${CF_API_BASE}${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        ...(init.headers as Record<string, string> | undefined),
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch (err) {
    const name = err instanceof Error ? err.name : ''
    const timedOut = name === 'TimeoutError' || name === 'AbortError'
    throw new D1HttpError(
      500,
      timedOut ? 'Cloudflare API request timed out.' : 'Cloudflare API request failed. Try again later.',
      'transport'
    )
  }
}

// Maps a non-2xx or failed Cloudflare response to a D1HttpError. Auth failures read as config
// problems (the operator's token), rate limits and SQL errors surface to the caller.
function cfError(res: Response, body: CfResponse<unknown>): D1HttpError {
  const first = body.errors?.[0]
  if (res.status === 401 || res.status === 403) {
    return new D1HttpError(500, 'Cloudflare API token is invalid or lacks D1 permission (needs "D1 Edit").', 'auth')
  }
  if (res.status === 429) {
    return new D1HttpError(res.status, 'Cloudflare API rate limit reached. Try again later.', 'rate_limit')
  }
  if (res.status >= 500) {
    return new D1HttpError(res.status, 'Cloudflare API request failed. Try again later.', 'transport')
  }
  return new D1HttpError(res.status, first?.message ?? `Cloudflare API error (${res.status}).`, 'sql')
}

// Lists every D1 database in the account (paginated). The application's own database is excluded
// unless ALLOW_APP_DB_AS_TARGET is explicitly enabled; the "ZETA_APP_DB_ID must be a real database
// in this account" fail-closed check applies either way.
export async function listAccountD1Databases(env: Env): Promise<CfD1Database[]> {
  const { accountId } = accountAndToken(env)
  const appId = appDbId(env)
  if (!appId) throw new D1HttpError(500, 'ZETA_APP_DB_ID is not configured on this Worker.', 'config')

  const all: CfD1Database[] = []
  let page = 1
  for (;;) {
    const res = await cfFetch(env, `/accounts/${accountId}/d1/database?page=${page}&per_page=${LIST_PER_PAGE}`)
    const body = (await res.json().catch(() => null)) as CfResponse<CfD1Database[]> | null
    if (!res.ok || !body || body.success === false) throw cfError(res, body ?? {})
    all.push(...(body.result ?? []))
    const info = body.result_info
    const total = info?.total_count ?? all.length
    if (!info || page * LIST_PER_PAGE >= total) break
    page++
  }

  // Fail closed on a mistyped ZETA_APP_DB_ID: the exclusion checks compare against this value, so
  // if it is not actually a database in the account, the app DB could slip through as a query
  // target. Require it to appear in the account's own list.
  if (!all.some((d) => d.uuid === appId)) {
    throw new D1HttpError(500, 'ZETA_APP_DB_ID is not a database in this Cloudflare account.', 'config')
  }
  return appDbTargetAllowed(env) ? all : all.filter((d) => d.uuid !== appId)
}

// Runs one statement against a D1 database over the HTTP API. The caller has already classified
// and permission-checked the statement, so the SQL sent here is a single, validated statement.
export async function queryD1Http(env: Env, databaseId: string, sql: string): Promise<D1QueryResult> {
  const { accountId } = accountAndToken(env)
  const res = await cfFetch(env, `/accounts/${accountId}/d1/database/${databaseId}/query`, {
    method: 'POST',
    body: JSON.stringify({ sql }),
  })
  const body = (await res.json().catch(() => null)) as CfResponse<
    Array<{ results?: Record<string, unknown>[]; meta?: Record<string, unknown>; success?: boolean }>
  > | null
  if (!res.ok || !body || body.success === false) throw cfError(res, body ?? {})

  const item = body.result?.[0]
  if (!item || item.success === false) {
    // A failed statement returns HTTP 200 with its error in the top-level errors array.
    throw new D1HttpError(res.status, body.errors?.[0]?.message ?? 'Query failed.', 'sql')
  }
  const meta = item.meta ?? {}
  return {
    results: item.results ?? [],
    meta,
    changes: typeof meta.changes === 'number' ? meta.changes : 0,
  }
}
