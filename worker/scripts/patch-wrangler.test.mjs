import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
// The runtime parser, so the injection layer is checked against the code that actually decides
// whether the switch is on instead of a re-implementation of it.
import { appDbTargetAllowed } from '../src/lib/d1-http.ts'
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
    expect(values('CF_ACCOUNT_ID')).toEqual([base.CLOUDFLARE_ACCOUNT_ID])
    expect(values('ZETA_APP_DB_ID')).toEqual([base.D1_DATABASE_ID])
    // Optional placeholder falls back to its fail-closed default when unset
    expect(values('ALLOW_APP_DB_AS_TARGET')).toEqual(['false'])
  })

  it('keeps hostile values inside their TOML strings', () => {
    const evil = 'a/b&c\\d$&$\'"\nmain = "evil.js"\n[[d1_databases]]\nbinding = "X'
    const { toml } = patchWrangler(template, { ...base, D1_DATABASE_NAME: evil })
    const { tables, values } = lines(toml)
    expect(values('main')).toEqual(['src/index.ts'])
    expect(tables.filter((t) => t === 'd1_databases')).toHaveLength(1)
    expect(values('binding')).toEqual(['ASSETS', 'DB', 'KV'])
    expect(values('database_name')).toEqual([evil])
    expect(values('database_id')).toEqual([base.D1_DATABASE_ID])
  })

  it('fails when a required variable is missing', () => {
    expect(() => patchWrangler(template, { ...base, D1_DATABASE_ID: ' ' })).toThrow(/D1_DATABASE_ID/)
  })

  it('fails when the template has already been patched', () => {
    const { toml } = patchWrangler(template, base)
    expect(() => patchWrangler(toml, base)).toThrow(/Expected exactly one/)
  })
})

// ALLOW_APP_DB_AS_TARGET is optional: unlike the other placeholders, a missing value must not
// fail the deploy. It is injected as "false" (fail closed) and the runtime helper keeps the
// final say — so the four runtime scenarios are asserted end-to-end, injected value included.
describe('ALLOW_APP_DB_AS_TARGET injection', () => {
  const injected = (allow) => {
    const { toml } = patchWrangler(template, { ...base, ALLOW_APP_DB_AS_TARGET: allow })
    return lines(toml).values('ALLOW_APP_DB_AS_TARGET')
  }
  const allowed = (allow) => appDbTargetAllowed({ ALLOW_APP_DB_AS_TARGET: injected(allow)[0] })

  it('injects "false" when the variable is unset', () => {
    expect(injected(undefined)).toEqual(['false'])
    expect(allowed(undefined)).toBe(false)
    // The rest of the placeholders are still filled, i.e. the deploy does not fail
    expect(patchWrangler(template, base).toml).not.toContain('PLACEHOLDER')
  })

  it('injects "false" when the variable is blank', () => {
    expect(injected('')).toEqual(['false'])
    expect(injected('   ')).toEqual(['false'])
    expect(allowed('   ')).toBe(false)
  })

  it('injects "true" as-is and the runtime turns the switch on', () => {
    expect(injected('true')).toEqual(['true'])
    expect(allowed('true')).toBe(true)
  })

  it('trims but does not lowercase, so " TRUE " is still on at runtime', () => {
    expect(injected(' TRUE ')).toEqual(['TRUE'])
    expect(allowed(' TRUE ')).toBe(true)
  })

  it('injects any other value verbatim, which the runtime reads as off', () => {
    expect(injected('1')).toEqual(['1'])
    expect(allowed('1')).toBe(false)
    expect(injected('yes')).toEqual(['yes'])
    expect(allowed('yes')).toBe(false)
    expect(injected('false')).toEqual(['false'])
    expect(allowed('false')).toBe(false)
    expect(injected('true-ish')).toEqual(['true-ish'])
    expect(allowed('true-ish')).toBe(false)
  })

  it('still fails when a required variable is missing', () => {
    const { D1_DATABASE_ID: _omitted, ...withoutDbId } = base
    expect(() => patchWrangler(template, withoutDbId)).toThrow(/D1_DATABASE_ID/)
  })
})
