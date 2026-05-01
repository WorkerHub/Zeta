import { getAccessToken, clearSession, setSession, getCurrentUser } from './auth'
import type { User, Notebook } from '../types'

// ── Base fetch wrapper ─────────────────────────────────────────────────────────

async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getAccessToken()
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(init.headers as Record<string, string> ?? {}),
  }
  if (token) headers['Authorization'] = `Bearer ${token}`

  const res = await fetch(`/api${path}`, { ...init, headers, credentials: 'include' })

  if (res.status === 401) {
    // Try to refresh silently
    const refreshed = await tryRefresh()
    if (refreshed) {
      // Retry once with new token
      const newToken = getAccessToken()
      if (newToken) headers['Authorization'] = `Bearer ${newToken}`
      const retry = await fetch(`/api${path}`, { ...init, headers, credentials: 'include' })
      if (!retry.ok) {
        const err = await retry.json().catch(() => ({}) as { error?: string })
        throw new ApiError((err as { error?: string }).error ?? retry.statusText, retry.status)
      }
      return retry.json() as Promise<T>
    }
    clearSession()
    window.location.href = '/login'
    throw new ApiError('Session expired', 401)
  }

  if (!res.ok) {
    const err = await res.json().catch(() => ({}) as { error?: string })
    throw new ApiError((err as { error?: string }).error ?? res.statusText, res.status)
  }

  return res.json() as Promise<T>
}

export class ApiError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message)
  }
}

async function tryRefresh(): Promise<boolean> {
  try {
    const res = await fetch('/api/auth/refresh', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
    })
    if (!res.ok) return false
    const data = await res.json() as { accessToken: string }
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
  register: (body: { email: string; password: string; name: string }) =>
    apiFetch<{ message: string }>('/auth/register', { method: 'POST', body: JSON.stringify(body) }),

  login: (body: { email: string; password: string }) =>
    apiFetch<{ accessToken?: string; user?: User; requires2fa?: boolean; pendingToken?: string; userId?: string }>(
      '/auth/login', { method: 'POST', body: JSON.stringify(body) }
    ),

  verify2faTotp: (body: { pendingToken: string; code: string }) =>
    apiFetch<{ accessToken: string; user: User }>(
      '/auth/2fa/totp', { method: 'POST', body: JSON.stringify(body) }
    ),

  sendEmailOtp: (body: { pendingToken: string }) =>
    apiFetch<{ message: string }>('/auth/2fa/email-otp/send', { method: 'POST', body: JSON.stringify(body) }),

  verifyEmailOtp: (body: { pendingToken: string; code: string }) =>
    apiFetch<{ accessToken: string; user: User }>(
      '/auth/2fa/email-otp/verify', { method: 'POST', body: JSON.stringify(body) }
    ),

  refresh: () =>
    apiFetch<{ accessToken: string }>('/auth/refresh', { method: 'POST' }),

  logout: () =>
    fetch('/api/auth/logout', { method: 'POST', credentials: 'include' }),

  forgotPassword: (body: { email: string }) =>
    apiFetch<{ message: string }>('/auth/forgot-password', { method: 'POST', body: JSON.stringify(body) }),

  resetPassword: (body: { token: string; password: string }) =>
    apiFetch<{ message: string }>('/auth/reset-password', { method: 'POST', body: JSON.stringify(body) }),

  verifyEmail: (token: string) =>
    apiFetch<{ message: string }>(`/auth/verify-email?token=${token}`),

  resendVerification: (body: { email: string }) =>
    apiFetch<{ message: string }>('/auth/resend-verification', { method: 'POST', body: JSON.stringify(body) }),
}

// ── Profile endpoints ─────────────────────────────────────────────────────────

export const profileApi = {
  me: () => apiFetch<User>('/profile/me'),
  update: (body: { name: string }) =>
    apiFetch<{ message: string }>('/profile/me', { method: 'PATCH', body: JSON.stringify(body) }),
  changePassword: (body: { currentPassword: string; newPassword: string }) =>
    apiFetch<{ message: string }>('/profile/change-password', { method: 'POST', body: JSON.stringify(body) }),

  setupTotp: () => apiFetch<{ secret: string; uri: string }>('/profile/totp/setup', { method: 'POST' }),
  confirmTotp: (body: { code: string; name?: string }) =>
    apiFetch<{ message: string }>('/profile/totp/confirm', { method: 'POST', body: JSON.stringify(body) }),
  deleteTotp: (id: string) => apiFetch<{ message: string }>(`/profile/totp/${id}`, { method: 'DELETE' }),

  passkeyRegisterOptions: () => apiFetch<Record<string, unknown>>('/profile/passkey/register/options', { method: 'POST' }),
  passkeyRegisterVerify: (body: unknown) =>
    apiFetch<{ message: string }>('/profile/passkey/register/verify', { method: 'POST', body: JSON.stringify(body) }),
  deletePasskey: (id: string) => apiFetch<{ message: string }>(`/profile/passkey/${id}`, { method: 'DELETE' }),
}

// ── Databases endpoints ───────────────────────────────────────────────────────

export const databasesApi = {
  list: () => apiFetch<Array<{ id: string; name: string; description: string | null; binding_name: string; permission: 'read' | 'write' }>>('/databases'),
}

// ── Query endpoints ───────────────────────────────────────────────────────────

export const queryApi = {
  execute: (body: { databaseId: string; sql: string }) =>
    apiFetch<{ results?: unknown[]; meta?: unknown; duration_ms?: number; error?: string }>(
      '/query', { method: 'POST', body: JSON.stringify(body) }
    ),
  history: (params?: { databaseId?: string; limit?: number; offset?: number }) => {
    const q = new URLSearchParams()
    if (params?.databaseId) q.set('databaseId', params.databaseId)
    if (params?.limit) q.set('limit', String(params.limit))
    if (params?.offset) q.set('offset', String(params.offset))
    return apiFetch<{ results: unknown[] }>(`/query/history?${q}`)
  },
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
  updateUser: (id: string, body: { role?: string; two_factor_required?: boolean }) =>
    apiFetch<{ message: string }>(`/admin/users/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  deleteUser: (id: string) => apiFetch<{ message: string }>(`/admin/users/${id}`, { method: 'DELETE' }),

  databases: () => apiFetch<{ results: unknown[] }>('/admin/databases'),
  createDatabase: (body: { name: string; description?: string; binding_name: string }) =>
    apiFetch<{ id: string }>('/admin/databases', { method: 'POST', body: JSON.stringify(body) }),
  updateDatabase: (id: string, body: { name?: string; description?: string; is_active?: boolean }) =>
    apiFetch<{ message: string }>(`/admin/databases/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  deleteDatabase: (id: string) => apiFetch<{ message: string }>(`/admin/databases/${id}`, { method: 'DELETE' }),

  getPermissions: (dbId: string) => apiFetch<{ results: unknown[] }>(`/admin/databases/${dbId}/permissions`),
  setPermission: (dbId: string, userId: string, permission: string) =>
    apiFetch<{ message: string }>(`/admin/databases/${dbId}/permissions/${userId}`, {
      method: 'PUT', body: JSON.stringify({ permission })
    }),
  revokePermission: (dbId: string, userId: string) =>
    apiFetch<{ message: string }>(`/admin/databases/${dbId}/permissions/${userId}`, { method: 'DELETE' }),

  getSettings: () => apiFetch<Record<string, string>>('/admin/settings'),
  updateSettings: (body: Record<string, string>) =>
    apiFetch<{ message: string }>('/admin/settings', { method: 'PATCH', body: JSON.stringify(body) }),

  setupStatus: () => apiFetch<{ setupCompleted: boolean; hasUsers: boolean }>('/setup-status'),
  completeSetup: () => apiFetch<{ message: string }>('/admin/setup/complete', { method: 'POST' }),
}

// ── Notebooks endpoints ───────────────────────────────────────────────────────

export const notebooksApi = {
  list: () =>
    apiFetch<{ results: Notebook[] }>('/notebooks'),
  create: (body: { name?: string; database_id?: string }) =>
    apiFetch<Notebook>('/notebooks', { method: 'POST', body: JSON.stringify(body) }),
  update: (id: string, body: Partial<Pick<Notebook, 'name' | 'sql_content' | 'database_id' | 'position'>>) =>
    apiFetch<{ message: string }>(`/notebooks/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  delete: (id: string) =>
    apiFetch<{ message: string }>(`/notebooks/${id}`, { method: 'DELETE' }),
}
