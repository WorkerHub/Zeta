import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { patchWrangler } from './patch-wrangler.mjs'

// Line-level view of the output: escaped values never contain a raw newline, so every
// `key = value` line and `[[table]]` header seen here is real TOML structure.
function lines(toml) {
  const tables = []
  const entries = []
  for (const line of toml.split('\n')) {
    const header = line.match(/^\s*\[\[?([^\]]+)\]\]?\s*$/)
    if (header) tables.push(header[1])
    const kv = line.match(/^\s*([A-Za-z_]+)\s*=\s*(.+)$/)
    if (kv) entries.push([kv[1], kv[2].startsWith('"') ? JSON.parse(kv[2]) : kv[2]])
  }
  const values = (key) => entries.filter(([k]) => k === key).map(([, v]) => v)
  return { tables, values }
}

const template = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8')
const base = {
  CLOUDFLARE_ACCOUNT_ID: '0123456789abcdef0123456789abcdef',
  D1_DATABASE_NAME: 'zeta-db',
  D1_DATABASE_ID: '11111111-2222-3333-4444-555555555555',
  KV_NAMESPACE_ID: 'fedcba9876543210fedcba9876543210',
}

describe('patchWrangler', () => {
  it('fills every placeholder', () => {
    const { toml } = patchWrangler(template, base)
    expect(toml).not.toContain('PLACEHOLDER')
    const { values } = lines(toml)
    expect(values('account_id')).toEqual([base.CLOUDFLARE_ACCOUNT_ID])
    expect(values('database_name')).toEqual(['zeta-db'])
    expect(values('database_id')).toEqual([base.D1_DATABASE_ID])
    expect(values('id')).toEqual([base.KV_NAMESPACE_ID])
  })

  it('keeps hostile values inside their TOML strings', () => {
    const evil = 'a/b&c\\d$&$\'"\nmain = "evil.js"\n[[d1_databases]]\nbinding = "X'
    const { toml } = patchWrangler(template, {
      ...base,
      D1_DATABASE_NAME: evil,
      QUERY_DB_1_NAME: evil,
      QUERY_DB_1_ID: 'id"1',
    })
    const { tables, values } = lines(toml)
    expect(values('main')).toEqual(['src/index.ts'])
    expect(tables.filter((t) => t === 'd1_databases')).toHaveLength(2)
    expect(values('binding')).toEqual(['ASSETS', 'DB', 'KV', 'QUERY_DB_1'])
    expect(values('database_name')).toEqual([evil, evil])
    expect(values('database_id')).toEqual([base.D1_DATABASE_ID, 'id"1'])
  })

  it('appends complete query databases and skips incomplete ones', () => {
    const { toml, log } = patchWrangler(template, {
      ...base,
      QUERY_DB_1_NAME: 'one',
      QUERY_DB_1_ID: 'id-1',
      QUERY_DB_2_NAME: 'two',
      QUERY_DB_10_NAME: 'ten',
      QUERY_DB_10_ID: 'id-10',
    })
    expect(lines(toml).values('binding')).toEqual(['ASSETS', 'DB', 'KV', 'QUERY_DB_1', 'QUERY_DB_10'])
    expect(log.some((l) => l.startsWith('WARNING: QUERY_DB_2'))).toBe(true)
  })

  it('does not let a value forge a GitHub Actions log command', () => {
    const { log } = patchWrangler(template, { ...base, QUERY_DB_1_NAME: 'x\n::error::boom', QUERY_DB_1_ID: 'i' })
    expect(log.every((l) => !l.includes('\n'))).toBe(true)
  })

  it('fails when a required variable is missing', () => {
    expect(() => patchWrangler(template, { ...base, D1_DATABASE_ID: ' ' })).toThrow(/D1_DATABASE_ID/)
  })

  it('fails when the template has already been patched', () => {
    const { toml } = patchWrangler(template, base)
    expect(() => patchWrangler(toml, base)).toThrow(/Expected exactly one/)
  })
})
