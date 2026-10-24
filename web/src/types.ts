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

export type DbPermission = 'read' | 'write' | 'write_drop'

export interface Database {
  id: string
  name: string
  description: string | null
  binding_name?: string
  cf_database_id?: string | null
  permission: DbPermission
  is_app_db?: boolean
}

// A registered database as the admin API returns it
export interface AdminDatabase {
  id: string
  name: string
  description: string | null
  binding_name: string
  cf_database_id: string | null
  is_active: number
  created_at: number
  is_app_db?: boolean
}

// A Cloudflare account D1 database as returned by GET /admin/d1/databases
export interface CfD1Database {
  uuid: string
  name: string
  created_at: string
  added: boolean
  database_id: string | null
  is_app_db?: boolean
}

export interface DatabaseGrant {
  id: string
  user_id: string
  database_id: string
  permission: DbPermission
  email: string
  user_name: string
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
  changes?: number // present for INSERT/UPDATE/DELETE
  truncated?: boolean // server capped the returned rows
  error?: string
  stored_rows?: number // a saved run kept only this many of the rows
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

// A saved notebook run, as listed (without its results)
export interface NotebookRunSummary {
  id: string
  seq: number // the run's number within its notebook (#1 = first); never changes, never reused
  notebook_id: string
  database_id: string
  database_name: string | null
  sql: string
  statement_count: number
  row_count: number
  error_count: number
  duration_ms: number
  storage_truncated: number
  results_bytes: number
  executed_at: number // milliseconds
  accessible: boolean // the user can still query its database (and so see its results)
}

export interface NotebookRun extends NotebookRunSummary {
  results: StatementResult[]
}

export interface RunSettings {
  run_limit: number | null // the user's own limit; null follows the admin limit
  admin_run_limit: number
  effective_run_limit: number
  storage_used_bytes: number
  storage_quota_bytes: number
}
