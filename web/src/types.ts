// ── Type definitions shared with the worker ───────────────────────────────────

export interface User {
  id: string
  email: string
  name: string
  role: 'admin' | 'member'
  email_verified: number
  two_factor_required: number
  created_at: number
  totpCredentials?: Array<{ id: string; name: string; created_at: number }>
  passkeyCredentials?: Array<{ id: string; name: string | null; created_at: number }>
}

export interface Database {
  id: string
  name: string
  description: string | null
  binding_name: string
  permission: 'read' | 'write'
}

export interface QueryResult {
  results: Record<string, unknown>[]
  meta?: Record<string, unknown>
  duration_ms?: number
  error?: string
}

export interface StatementResult {
  sql: string
  results: Record<string, unknown>[]
  duration_ms: number
  changes?: number   // present for INSERT/UPDATE/DELETE
  error?: string
}

export interface QueryHistoryItem {
  id: string
  user_id: string
  database_id: string
  sql: string
  duration_ms: number | null
  row_count: number | null
  error: string | null
  executed_at: number
}

export interface Notebook {
  id: string
  user_id: string
  name: string
  sql_content: string
  database_id: string | null
  position: number
  created_at: number
  updated_at: number
}
