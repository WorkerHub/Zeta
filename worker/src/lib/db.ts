import type { Env } from '../types'

export function now(): number {
  return Math.floor(Date.now() / 1000)
}

export async function getSetting(env: Env, key: string): Promise<string | null> {
  const row = await env.DB.prepare(
    'SELECT value FROM settings WHERE key = ?1'
  ).bind(key).first<{ value: string }>()
  return row?.value ?? null
}

export async function setSetting(env: Env, key: string, value: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, ?3)
     ON CONFLICT(key) DO UPDATE SET value = ?2, updated_at = ?3`
  ).bind(key, value, now()).run()
}

export async function getSettings(env: Env, keys: string[]): Promise<Record<string, string>> {
  const placeholders = keys.map((_, i) => `?${i + 1}`).join(',')
  const rows = await env.DB.prepare(
    `SELECT key, value FROM settings WHERE key IN (${placeholders})`
  ).bind(...keys).all<{ key: string; value: string }>()
  const map: Record<string, string> = {}
  for (const r of rows.results) map[r.key] = r.value
  return map
}

export async function audit(
  env: Env,
  opts: { userId?: string; action: string; resource?: string; metadata?: unknown; ip?: string; userAgent?: string }
): Promise<void> {
  const { nanoid } = await import('./id')
  await env.DB.prepare(
    `INSERT INTO audit_logs (id, user_id, action, resource, metadata, ip, user_agent, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`
  ).bind(
    nanoid(),
    opts.userId ?? null,
    opts.action,
    opts.resource ?? null,
    opts.metadata ? JSON.stringify(opts.metadata) : null,
    opts.ip ?? null,
    opts.userAgent ?? null,
    now()
  ).run()
}
