import { getAccessToken, clearSession, setSession, getCurrentUser } from './auth'
import type { ThemeColor } from './theme-color'
import type {
  AdminDatabase,
  CfD1Database,
  Database,
  DatabaseGrant,
  DbKind,
  Notebook,
  NotebookRun,
  NotebookRunSummary,
  RunSettings,
  StatementResult,
  User,
} from '../types'

// ── Base fetch wrapper ─────────────────────────────────────────────────────────

interface ApiOptions {
  // A 401 from this endpoint means bad credentials, not an expired session:
  // surface the error instead of refreshing and redirecting to /login.
  noSessionRetry?: boolean
}

async function apiFetch<T>(path: string, init: RequestInit = {}, opts: ApiOptions = {}): Promise<T> {
  const token = getAccessToken()
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...((init.headers as Record<string, string>) ?? {}),
  }
  if (token) headers.Authorization = `Bearer ${token}`

  const res = await fetch(`/api${path}`, { ...init, headers, credentials: 'include' })

  if (res.status === 401 && !opts.noSessionRetry) {
    // Try to refresh silently
    const refreshed = await tryRefresh()
    if (refreshed) {
      // Retry once with new token
      const newToken = getAccessToken()
      if (newToken) headers.Authorization = `Bearer ${newToken}`
      const retry = await fetch(`/api${path}`, { ...init, headers, credentials: 'include' })
      if (!retry.ok) {
        const err = await retry.json().catch(() => ({}) as { error?: string })
        throw new ApiError((err as { error?: string }).error ?? retry.statusText, retry.status, err)
      }
      return retry.json() as Promise<T>
    }
    clearSession()
    window.location.href = '/login'
    throw new ApiError('Session expired', 401)
  }

  if (!res.ok) {
    const err = await res.json().catch(() => ({}) as { error?: string })
    throw new ApiError((err as { error?: string }).error ?? res.statusText, res.status, err)
  }

  return res.json() as Promise<T>
}

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    // The parsed error response, for endpoints that send more than `error` (e.g. a saved run's id)
    public readonly body: Record<string, unknown> = {}
  ) {
    super(message)
  }
}

// A failed POST /api/setup carries a `Retry-After` header when rate limited (429); surface it so
// the setup page can tell the user how long to wait.
export class SetupApiError extends ApiError {
  constructor(
    message: string,
    status: number,
    public readonly retryAfter: string | null
  ) {
    super(message, status)
  }
}

let refreshPromise: Promise<boolean> | null = null

async function tryRefresh(): Promise<boolean> {
  if (refreshPromise) return refreshPromise
  refreshPromise = doRefresh()
  try {
    return await refreshPromise
  } finally {
    refreshPromise = null
  }
}

async function doRefresh(): Promise<boolean> {
  try {
    const res = await fetch('/api/auth/refresh', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
    })
    if (!res.ok) return false
    const data = (await res.json()) as { accessToken: string }
    const user = getCurrentUser()
    if (data.accessToken && user) {
      setSession(data.accessToken, user)
      return true
    }
    return false
  } catch {
    return false
  }
}

// ── Auth endpoints ─────────────────────────────────────────────────────────────

export const authApi = {
  registerStatus: () => apiFetch<{ enabled: boolean }>('/auth/register-status'),

  register: (body: { email: string; password: string; name: string }) =>
    apiFetch<{ message: string }>('/auth/register', { method: 'POST', body: JSON.stringify(body) }),

  login: async (body: { email: string; password: string }) => {
    // Use raw fetch to avoid apiFetch's 401→"Session expired" intercept:
    // login's 401 means wrong credentials, not an expired session.
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      credentials: 'include',
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({}) as { error?: string })
      throw new ApiError((err as { error?: string }).error ?? res.statusText, res.status)
    }
    return res.json() as Promise<{ accessToken?: string; user?: User; requires2fa?: boolean; pendingToken?: string }>
  },

  verify2faTotp: (body: { pendingToken: string; code: string }) =>
    apiFetch<{ accessToken: string; user: User }>(
      '/auth/2fa/totp',
      { method: 'POST', body: JSON.stringify(body) },
      { noSessionRetry: true }
    ),

  sendEmailOtp: (body: { pendingToken: string }) =>
    apiFetch<{ message: string }>(
      '/auth/2fa/email-otp/send',
      { method: 'POST', body: JSON.stringify(body) },
      { noSessionRetry: true }
    ),

  verifyEmailOtp: (body: { pendingToken: string; code: string }) =>
    apiFetch<{ accessToken: string; user: User }>(
      '/auth/2fa/email-otp/verify',
      { method: 'POST', body: JSON.stringify(body) },
      { noSessionRetry: true }
    ),

  passkey2faOptions: (body: { pendingToken: string }) =>
    apiFetch<Record<string, unknown>>(
      '/auth/2fa/passkey/options',
      { method: 'POST', body: JSON.stringify(body) },
      { noSessionRetry: true }
    ),

  verify2faPasskey: (body: { pendingToken: string; credential: unknown }) =>
    apiFetch<{ accessToken: string; user: User }>(
      '/auth/2fa/passkey/verify',
      { method: 'POST', body: JSON.stringify(body) },
      { noSessionRetry: true }
    ),

  refresh: () => apiFetch<{ accessToken: string }>('/auth/refresh', { method: 'POST' }),

  logout: () => fetch('/api/auth/logout', { method: 'POST', credentials: 'include' }),

  forgotPassword: (body: { email: string }) =>
    apiFetch<{ message: string }>('/auth/forgot-password', { method: 'POST', body: JSON.stringify(body) }),

  resetPassword: (body: { token: string; password: string }) =>
    apiFetch<{ message: string }>(
      '/auth/reset-password',
      { method: 'POST', body: JSON.stringify(body) },
      { noSessionRetry: true }
    ),

  verifyEmail: (token: string) =>
    apiFetch<{ message: string }>(`/auth/verify-email?token=${encodeURIComponent(token)}`),

  resendVerification: (body: { email: string }) =>
    apiFetch<{ message: string }>('/auth/resend-verification', { method: 'POST', body: JSON.stringify(body) }),
}

// ── Profile endpoints ─────────────────────────────────────────────────────────

export const profileApi = {
  me: () => apiFetch<User>('/profile/me'),
  update: (body: { name: string }) =>
    apiFetch<{ message: string }>('/profile/me', { method: 'PATCH', body: JSON.stringify(body) }),
  themeColor: (signal?: AbortSignal) => apiFetch<{ theme_color: string | null }>('/profile/theme-color', { signal }),
  updateThemeColor: (color: ThemeColor) =>
    apiFetch<{ theme_color: string }>('/profile/theme-color', {
      method: 'PUT',
      body: JSON.stringify({ theme_color: color }),
    }),
  changePassword: (body: { currentPassword: string; newPassword: string }) =>
    apiFetch<{ message: string }>('/profile/change-password', { method: 'POST', body: JSON.stringify(body) }),

  setupTotp: () => apiFetch<{ secret: string; uri: string }>('/profile/totp/setup', { method: 'POST' }),
  confirmTotp: (body: { code: string; name?: string }) =>
    apiFetch<{ message: string }>('/profile/totp/confirm', { method: 'POST', body: JSON.stringify(body) }),
  deleteTotp: (id: string, currentPassword: string) =>
    apiFetch<{ message: string }>(`/profile/totp/${id}`, {
      method: 'DELETE',
      body: JSON.stringify({ currentPassword }),
    }),

  runSettings: () => apiFetch<RunSettings>('/profile/run-settings'),
  updateRunSettings: (body: { run_limit: number | null }) =>
    apiFetch<RunSettings>('/profile/run-settings', { method: 'PUT', body: JSON.stringify(body) }),

  passkeyRegisterOptions: () =>
    apiFetch<Record<string, unknown>>('/profile/passkey/register/options', { method: 'POST' }),
  passkeyRegisterVerify: (body: unknown) =>
    apiFetch<{ message: string }>('/profile/passkey/register/verify', { method: 'POST', body: JSON.stringify(body) }),
  deletePasskey: (id: string, currentPassword: string) =>
    apiFetch<{ message: string }>(`/profile/passkey/${id}`, {
      method: 'DELETE',
      body: JSON.stringify({ currentPassword }),
    }),
}

// ── Databases endpoints ───────────────────────────────────────────────────────

export const databasesApi = {
  list: () => apiFetch<Database[]>('/databases'),
}

// ── Query endpoints ───────────────────────────────────────────────────────────

// Passing notebookId saves the run under that notebook; the response then names it
// (run_id, its number seq, executed_at in milliseconds). A failed single statement carries them in
// ApiError.body. The optional signal lets the caller cancel: it is a client-side fetch option and
// does not change the request or response shape.
export const queryApi = {
  // Proves the target answers before the page lets a query run (the connect button). The worker runs
  // a fixed `select 1` and records nothing — no history row, no saved run — and a D1 target answers
  // without touching D1. Failures carry the worker's message and, for Spark, a `code` the UI
  // translates (see lib/error-copy.ts).
  probe: (databaseId: string) =>
    apiFetch<{ ok: boolean; kind?: DbKind; latency_ms?: number }>('/query/probe', {
      method: 'POST',
      body: JSON.stringify({ databaseId }),
    }),
  execute: (
    body: {
      databaseId: string
      sql: string
      notebookId?: string
      sessionDatabase?: string
      executionId?: string
    },
    signal?: AbortSignal
  ) =>
    apiFetch<{
      results?: Record<string, unknown>[]
      meta?: { changes?: number }
      duration_ms?: number
      truncated?: boolean
      error?: string
      // The user cancelled this execution before/while it ran: `results` is empty and the saved
      // run's statement carries `cancelled` instead of an error. left out or false = it ran.
      cancelled?: boolean
      run_id?: string
      seq?: number
      executed_at?: number
    }>('/query', { method: 'POST', body: JSON.stringify(body), signal }),
  // A notebook's several statements in one request. A statement that fails stops the batch:
  // `results` then holds only the statements that were attempted (the failing one included) and
  // `halted` is true — the run reports how many never ran. Every statement ran when it is false
  // or left out.
  executeBatch: (
    body: {
      databaseId: string
      statements: string[]
      notebookId?: string
      sessionDatabase?: string
      executionId?: string
    },
    signal?: AbortSignal
  ) =>
    apiFetch<{
      results: StatementResult[]
      halted?: boolean
      // The user cancelled the batch: the statement in flight is returned with `cancelled: true`
      // (no error) and the statements after it never ran. left out or false = it ran to the end.
      cancelled?: boolean
      run_id?: string
      seq?: number
      executed_at?: number
    }>('/query/batch', {
      method: 'POST',
      body: JSON.stringify(body),
      signal,
    }),
  // Cancels an execution addressable by the id its request carried (`executionId`). The request
  // that is running is not aborted: it returns on its own, with `cancelled: true` once the worker
  // stops it. `cancelled: false` means the execution had already finished. 404 = unknown id, or
  // another user's execution (an ApiError with status 404).
  cancel: (executionId: string) =>
    apiFetch<{ ok: boolean; cancelled: boolean }>('/query/cancel', {
      method: 'POST',
      body: JSON.stringify({ executionId }),
    }),
}

// ── Setup endpoints ───────────────────────────────────────────────────────────

// These are public (no auth) and need the raw response/status/headers, so they use fetch directly
// instead of apiFetch (whose 401 handling and JSON-only errors don't apply here).
export const setupApi = {
  // GET /api/setup/state → { enabled: boolean }. Throws on network/5xx so the page can fall back
  // to "treat as available" instead of a blank screen.
  state: async (): Promise<{ enabled: boolean }> => {
    const res = await fetch('/api/setup/state', { credentials: 'include' })
    if (!res.ok) throw new Error(`Setup state unavailable (${res.status})`)
    return (await res.json()) as { enabled: boolean }
  },

  // POST /api/setup — the secret travels only in the JSON body, never the URL.
  run: async (secret: string): Promise<{ ok: true; message: string; upgraded?: string[] }> => {
    const res = await fetch('/api/setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret }),
      credentials: 'include',
    })
    const retryAfter = res.headers.get('Retry-After')
    const body = (await res.json().catch(() => ({}))) as {
      ok?: boolean
      message?: string
      upgraded?: string[]
      error?: string
    }
    if (!res.ok) throw new SetupApiError(body.error ?? res.statusText, res.status, retryAfter)
    return { ok: true, message: body.message ?? '', upgraded: body.upgraded }
  },
}

// ── Admin setup endpoint ──────────────────────────────────────────────────────

export interface AdminSetupResult {
  ok: true
  message: string
  upgraded?: string[]
  permissionsRepair?: Record<string, unknown>
}

// POST /api/admin/setup — the signed-in admin's session authorizes this (no setup secret).
// Reuses apiFetch so a 401 refreshes/redirects like every other admin call.
export const adminSetupApi = {
  run: () => apiFetch<AdminSetupResult>('/admin/setup', { method: 'POST' }),
}

// ── Admin endpoints ───────────────────────────────────────────────────────────

export const adminApi = {
  users: (params?: { search?: string; limit?: number; offset?: number }) => {
    const q = new URLSearchParams()
    if (params?.search) q.set('search', params.search)
    if (params?.limit) q.set('limit', String(params.limit))
    if (params?.offset) q.set('offset', String(params.offset))
    return apiFetch<{ results: User[]; total: number }>(`/admin/users?${q}`)
  },
  getUser: (id: string) => apiFetch<User>(`/admin/users/${id}`),
  createUser: (body: { name: string; email: string; password: string; role: string }) =>
    apiFetch<{ id: string }>('/admin/users', { method: 'POST', body: JSON.stringify(body) }),
  updateUser: (
    id: string,
    body: { role?: string; two_factor_required?: boolean; name?: string; email?: string; password?: string }
  ) => apiFetch<{ message: string }>(`/admin/users/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  deleteUser: (id: string) => apiFetch<{ message: string }>(`/admin/users/${id}`, { method: 'DELETE' }),

  databases: () => apiFetch<{ results: AdminDatabase[] }>('/admin/databases'),
  listD1Databases: () => apiFetch<{ results: CfD1Database[] }>('/admin/d1/databases'),
  // One live connection to a pasted target; stores nothing. The registration form gates its save
  // button on a passing result for the exact values it is about to submit. `kind` defaults to
  // postgres on the worker, which is what this endpoint served before MySQL existed. Spark sends
  // its publish address as `connection_url` plus the two tokens.
  testConnection: (body: {
    connection_url: string
    kind?: 'postgres' | 'mysql' | 'spark'
    platform_token?: string
    app_token?: string
  }) =>
    apiFetch<{
      ok: boolean
      kind?: 'postgres' | 'mysql' | 'spark'
      server_version?: string
      latency_ms?: number
    }>('/admin/databases/test-connection', { method: 'POST', body: JSON.stringify(body) }),
  createDatabase: (body: {
    kind?: DbKind
    connection_url?: string
    platform_token?: string
    app_token?: string
    cf_database_id?: string
    name?: string
    description?: string
    provider?: string
  }) => apiFetch<{ id: string }>('/admin/databases', { method: 'POST', body: JSON.stringify(body) }),
  updateDatabase: (
    id: string,
    body: {
      name?: string
      description?: string
      is_active?: boolean
      cf_database_id?: string
      provider?: string
      connection_url?: string
      platform_token?: string
      app_token?: string
    }
  ) => apiFetch<{ message: string }>(`/admin/databases/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  deleteDatabase: (id: string) => apiFetch<{ message: string }>(`/admin/databases/${id}`, { method: 'DELETE' }),

  getPermissions: (dbId: string) => apiFetch<{ results: DatabaseGrant[] }>(`/admin/databases/${dbId}/permissions`),
  setPermission: (dbId: string, userId: string, permission: string) =>
    apiFetch<{ message: string }>(`/admin/databases/${dbId}/permissions/${userId}`, {
      method: 'PUT',
      body: JSON.stringify({ permission }),
    }),
  revokePermission: (dbId: string, userId: string) =>
    apiFetch<{ message: string }>(`/admin/databases/${dbId}/permissions/${userId}`, { method: 'DELETE' }),

  getSettings: () => apiFetch<Record<string, string>>('/admin/settings'),
  updateSettings: (body: Record<string, string>) =>
    apiFetch<{ message: string }>('/admin/settings', { method: 'PATCH', body: JSON.stringify(body) }),
  testEmail: (to: string) =>
    apiFetch<{ success: boolean }>('/admin/settings/test-email', { method: 'POST', body: JSON.stringify({ to }) }),
}

// ── Notebooks endpoints ───────────────────────────────────────────────────────

export const notebooksApi = {
  list: () => apiFetch<{ results: Notebook[] }>('/notebooks'),
  create: (body: { name?: string; database_id?: string }) =>
    apiFetch<Notebook>('/notebooks', { method: 'POST', body: JSON.stringify(body) }),
  update: (id: string, body: Partial<Pick<Notebook, 'name' | 'sql_content' | 'database_id' | 'position'>>) =>
    apiFetch<{ message: string }>(`/notebooks/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  delete: (id: string) => apiFetch<{ message: string }>(`/notebooks/${id}`, { method: 'DELETE' }),

  // Newest first; `before` continues below that run number
  runs: (id: string, params: { limit?: number; before?: number } = {}) => {
    const q = new URLSearchParams()
    if (params.limit) q.set('limit', String(params.limit))
    if (params.before) q.set('before', String(params.before))
    return apiFetch<{ results: NotebookRunSummary[]; has_more: boolean }>(`/notebooks/${id}/runs?${q}`)
  },
  run: (id: string, runId: string) => apiFetch<NotebookRun>(`/notebooks/${id}/runs/${runId}`),
  deleteRun: (id: string, runId: string) =>
    apiFetch<{ message: string }>(`/notebooks/${id}/runs/${runId}`, { method: 'DELETE' }),
  clearRuns: (id: string) => apiFetch<{ message: string }>(`/notebooks/${id}/runs`, { method: 'DELETE' }),
}
