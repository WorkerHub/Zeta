import type { D1Database } from '@cloudflare/workers-types'
import type { Env } from '../types'
import { nanoid } from './id'

// The prefix used when TABLE_PREFIX is not configured at all (state 1 of the three-state
// contract): every table name gains `zeta_`, e.g. zeta_users. An explicitly configured value is
// used verbatim instead.
export const DEFAULT_TABLE_PREFIX = 'zeta'

// The single place where TABLE_PREFIX is resolved:
//   TABLE_PREFIX unset            → DEFAULT_TABLE_PREFIX + '_'  (e.g. zeta_users)
//   TABLE_PREFIX non-empty        → the value + '_', kept verbatim including its case
//                                    (TABLE_PREFIX=ZETA → ZETA_users; never case-folded)
//   TABLE_PREFIX set to ''        → no prefix (the deployer owns the table-collision risk)
// Validation is unchanged: once the trailing '_' is added, anything but [A-Za-z0-9_] throws.
export function tablePrefix(env: Pick<Env, 'TABLE_PREFIX'>): string {
  if (env.TABLE_PREFIX === '') return ''
  const p = `${env.TABLE_PREFIX ?? DEFAULT_TABLE_PREFIX}_`
  if (!/^[A-Za-z0-9_]+$/.test(p)) throw new Error('TABLE_PREFIX contains invalid characters')
  return p
}

export function tables(env: Pick<Env, 'TABLE_PREFIX'>) {
  const p = tablePrefix(env)
  return {
    users: `${p}users`,
    totp_credentials: `${p}totp_credentials`,
    passkey_credentials: `${p}passkey_credentials`,
    d1_databases: `${p}d1_databases`,
    user_database_permissions: `${p}user_database_permissions`,
    query_history: `${p}query_history`,
    settings: `${p}settings`,
    audit_logs: `${p}audit_logs`,
    notebooks: `${p}notebooks`,
    notebook_runs: `${p}notebook_runs`,
    rate_limits: `${p}rate_limits`,
  }
}

// ── Existing-schema detection (anti-silent-switch guard) ─────────────────────────────────────

// The unprefixed names of the 11 Zeta tables double as the family suffixes: any table named
// `<something>users`, `<something>settings` … belongs to the family, with `<something>_` as its
// prefix (and a bare `users` means an unprefixed schema).
const FAMILY_TABLES = Object.values(tables({ TABLE_PREFIX: '' }))

// The oldest complete Zeta schema (migrations/0001) already created 9 of the 11 tables, so 9
// hits under one prefix means “an initialised Zeta schema lives here”. A foreign project sharing
// this D1 database cannot reach that count by accident, and the threshold deliberately counts
// only family hits — never the total number of tables in a shared database.
const MIN_FAMILY_TABLES = 9

export interface ExistingTableFamily {
  // '' for an unprefixed schema, otherwise the prefix with its trailing '_' (e.g. 'ZETA_')
  prefix: string
  // how many of the 11 family tables were found under that prefix
  tableCount: number
}

// Scans sqlite_master for an initialised Zeta table family under any prefix. This is the eyes of
// the anti-silent-switch guard: runSetup() refuses to initialise when it finds a family whose
// prefix differs from the resolved one, instead of silently stranding the existing data under a
// new set of tables. Only table NAMES are read, and only the 11 Zeta family names are ever
// matched — other projects' tables (SL_*, eNotify_*, …) are neither counted nor interpreted.
export async function detectExistingTableFamily(db: D1Database): Promise<ExistingTableFamily | null> {
  const rows = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all<{ name: string }>()
  const hits = new Map<string, number>()
  for (const { name } of rows.results) {
    for (const table of FAMILY_TABLES) {
      if (name === table || name.endsWith(`_${table}`)) {
        const prefix = name.slice(0, name.length - table.length)
        hits.set(prefix, (hits.get(prefix) ?? 0) + 1)
        break
      }
    }
  }
  let best: ExistingTableFamily | null = null
  for (const [prefix, tableCount] of hits) {
    if (tableCount >= MIN_FAMILY_TABLES && tableCount > (best?.tableCount ?? 0)) best = { prefix, tableCount }
  }
  return best
}

export function now(): number {
  return Math.floor(Date.now() / 1000)
}

export async function getSetting(env: Env, key: string): Promise<string | null> {
  const T = tables(env)
  const row = await env.DB.prepare(`SELECT value FROM ${T.settings} WHERE key = ?1`)
    .bind(key)
    .first<{ value: string }>()
  return row?.value ?? null
}

export async function setSetting(env: Env, key: string, value: string): Promise<void> {
  const T = tables(env)
  await env.DB.prepare(
    `INSERT INTO ${T.settings} (key, value, updated_at) VALUES (?1, ?2, ?3)
     ON CONFLICT(key) DO UPDATE SET value = ?2, updated_at = ?3`
  )
    .bind(key, value, now())
    .run()
}

export async function getSettings(env: Env, keys: string[]): Promise<Record<string, string>> {
  if (keys.length === 0) return {}
  const T = tables(env)
  const placeholders = keys.map((_, i) => `?${i + 1}`).join(',')
  const rows = await env.DB.prepare(`SELECT key, value FROM ${T.settings} WHERE key IN (${placeholders})`)
    .bind(...keys)
    .all<{ key: string; value: string }>()
  const map: Record<string, string> = {}
  for (const r of rows.results) map[r.key] = r.value
  return map
}

export async function audit(
  env: Env,
  opts: { userId?: string; action: string; resource?: string; metadata?: unknown; ip?: string; userAgent?: string }
): Promise<void> {
  const T = tables(env)
  await env.DB.prepare(
    `INSERT INTO ${T.audit_logs} (id, user_id, action, resource, metadata, ip, user_agent, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`
  )
    .bind(
      nanoid(),
      opts.userId ?? null,
      opts.action,
      opts.resource ?? null,
      opts.metadata ? JSON.stringify(opts.metadata) : null,
      opts.ip ?? null,
      opts.userAgent ?? null,
      now()
    )
    .run()
}
