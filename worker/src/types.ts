import type { KVNamespace, D1Database, Fetcher } from '@cloudflare/workers-types'

export interface Env {
  // App storage
  DB: D1Database
  KV: KVNamespace
  ASSETS: Fetcher
  // Secrets (set via CF dashboard)
  JWT_SECRET: string
  ENCRYPTION_KEY: string   // 64-char hex string (32 bytes) for AES-GCM TOTP encryption
  SETUP_SECRET: string     // random secret used for the /api/setup/:secret endpoint
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
}
