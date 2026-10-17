import type { KVNamespace, D1Database, Fetcher } from '@cloudflare/workers-types'

export interface Env {
  // App storage
  DB: D1Database
  KV: KVNamespace
  ASSETS: Fetcher
  // Secrets (set via CF dashboard)
  JWT_SECRET: string
  ENCRYPTION_KEY: string // 64-char hex string (32 bytes) for AES-GCM TOTP encryption
  SETUP_SECRET: string // random secret required by POST /api/setup
  // Vars (set via CF dashboard)
  APP_URL: string
  TABLE_PREFIX?: string
  // Additional queryable D1 databases – dynamic bindings
  [key: string]: unknown
}

export interface Variables {
  userId: string
  userRole: 'admin' | 'member'
  // Set only during pending-2FA phase
  pendingUserId?: string
}

// ── DB Row Types ─────────────────────────────────────────────────────────────

export interface UserRow {
  id: string
  email: string
  password_hash: string | null
  name: string
  role: 'admin' | 'member'
  email_verified: number
  two_factor_required: number
  created_at: number
  updated_at: number
}

export interface TotpCredentialRow {
  id: string
  user_id: string
  encrypted_secret: string
  name: string
  created_at: number
}

export interface PasskeyCredentialRow {
  id: string
  user_id: string
  credential_id: string
  public_key: string
  sign_count: number
  name: string | null
  created_at: number
}

export interface DatabaseRow {
  id: string
  name: string
  description: string | null
  binding_name: string
  is_active: number
  created_at: number
  created_by: string | null
}

export interface PermissionRow {
  id: string
  user_id: string
  database_id: string
  permission: 'read' | 'write' | 'write_drop'
  granted_by: string | null
  granted_at: number
}

export interface QueryHistoryRow {
  id: string
  user_id: string
  database_id: string
  sql: string
  duration_ms: number | null
  row_count: number | null
  error: string | null
  executed_at: number
}

export interface SettingRow {
  key: string
  value: string
  updated_at: number
}

export interface NotebookRow {
  id: string
  user_id: string
  name: string
  sql_content: string
  database_id: string | null
  position: number
  created_at: number
  updated_at: number
  last_run_seq: number // number of the notebook's latest run (see lib/runs.ts reserveRunSeq)
}

export interface NotebookRunRow {
  id: string
  seq: number // the run's number within its notebook; never changes, never reused
  notebook_id: string
  user_id: string
  database_id: string
  sql: string
  statement_count: number
  row_count: number
  error_count: number
  duration_ms: number
  storage_truncated: number
  results_bytes: number
  executed_at: number // milliseconds
  results: string // JSON: the run's statement results
}
