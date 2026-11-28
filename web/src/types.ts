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

export type DbPermission = 'read' | 'write' | 'write_drop' | 'manage'

// The engine a registration targets. 'sqlite' is the existing D1 path; the others are
// registered from a connection string. Absent on responses from before the kind column.
export type DbKind = 'sqlite' | 'postgres' | 'mysql' | 'spark'

export interface Database {
  id: string
  name: string
  description: string | null
  kind?: DbKind
  // The provider this target runs on, for display only: the registration's own text when it has one,
  // otherwise the provider Zeta registers that engine on (see lib/db-provider.ts)
  provider?: string | null
  binding_name?: string
  cf_database_id?: string | null
  permission: DbPermission
  is_app_db?: boolean
  has_spark_ui?: boolean
  has_livy?: boolean
}

// A registered database as the admin API returns it
export interface AdminDatabase {
  id: string
  name: string
  description: string | null
  kind?: DbKind
  // The effective provider (display) and the admin's own text as typed (form prefill only)
  provider?: string | null
  provider_custom?: string | null
  binding_name: string
  cf_database_id: string | null
  is_active: number
  created_at: number
  is_app_db?: boolean
  has_spark_ui?: boolean
  has_livy?: boolean
}

export type LivySessionKind = 'spark' | 'pyspark' | 'sql'

export interface LivySession {
  id: number
  state: string
  kind: string
  appId: string | null
  log?: string[]
}

export interface LivyStatementOutput {
  status: string
  execution_count?: number
  data?: {
    'text/plain'?: string
    'application/json'?: unknown
    [key: string]: unknown
  }
  ename?: string
  evalue?: string
  traceback?: string[]
}

export interface LivyStatement {
  id: number
  code: string
  state: string
  output: LivyStatementOutput | null
  progress: number
}

export interface LivyBatch {
  id: string | number
  batch_id?: number
  file: string
  class_name: string | null
  created_at: number
  state: string
  appId: string | null
}

export interface LivyBatchLog {
  id: number
  from: number
  size: number
  total: number
  log: string[]
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
  cancelled?: boolean // the user cancelled this statement while it ran (never an error)
  // Spark state codes the worker rides along on a batch entry (§7.6): a rejected profile key
  // (`startup_key_in_profile` / `invalid_key`) or a draining/restarting/rebuilt environment.
  // A plain SQL error carries none of these.
  code?: string
  key?: string
  inflight?: number
  epoch?: number
}

// A single Spark profile entry (key = value), kept in order so blank lines and their order survive
// an edit (SPEC §5.1/§5.2).
export interface ProfileEntry {
  key: string
  value: string
}

// A personal Spark config profile as the API returns it.
export interface SparkProfile {
  id: string
  name: string
  entries: ProfileEntry[]
  updated_at: number
}

// One jar of a Spark instance config (SPEC §1.2/§6.2): a URL the service downloads, or a file name
// already in its jars directory. Only a URL ref may pin a sha256.
export interface JarRef {
  type: 'url' | 'file'
  value: string
  sha256?: string
}

// The Spark service's own state (SPEC §1.2 `GET /admin/config/status`, passed through by Zeta).
export type SparkConfigState = 'running' | 'draining' | 'restarting' | 'failed_fallback'

export interface SparkConfigStatus {
  state: SparkConfigState
  epoch: number
  inflight: number
  // What the service is actually running — the jar list holds file names.
  effective: { entries: Record<string, string>; jars: string[] }
  lastError: string | null
}

// One file of the service's jars directory (SPEC §1.2 `GET /admin/jars`).
export interface ServerJar {
  name: string
  sizeBytes: number
}

// `GET /api/databases/:id/spark-instance-config`: the stored expected config plus the service's
// current status and jar listing, each null when the service cannot be reached (SPEC §6.1).
export interface SparkInstanceConfigResponse {
  entries: Record<string, string>
  jars: JarRef[]
  status: SparkConfigStatus | null
  serverJars: ServerJar[] | null
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
  statement_count: number // statements the run submitted; a halted run returns fewer results
  // The batch stopped at a failing statement, so fewer statements are in `results` than were
  // submitted. false for a run whose every statement ran (stored with the run, see lib/runs.ts).
  halted?: boolean
  // The user cancelled the run: it stopped early on purpose (stored with the run), so its tab and
  // its results announce a cancellation rather than a success (see lib/runs.ts).
  cancelled?: boolean
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
