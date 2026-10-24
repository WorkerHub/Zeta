import { describe, expect, it } from 'vitest'
import type { DatabaseRow, Env } from '../../types'
import { resolveQueryTarget } from '../bindings'

const env = {
  DB: {},
  KV: {},
  ASSETS: {},
  JWT_SECRET: 'jwt',
  ENCRYPTION_KEY: 'k',
  SETUP_SECRET: 's',
  APP_URL: 'u',
} as unknown as Env

describe('resolveQueryTarget', () => {
  const dbRow = (over: Partial<DatabaseRow>): DatabaseRow => ({
    id: 'x',
    name: 'n',
    description: null,
    binding_name: 'QUERY_DB_1',
    cf_database_id: null,
    is_active: 1,
    created_at: 0,
    created_by: null,
    ...over,
  })
  const envWithAppDb = { ...env, ZETA_APP_DB_ID: 'app-uuid' } as unknown as Env

  it('resolves a cf_database_id to an HTTP target', () => {
    const r = resolveQueryTarget(envWithAppDb, dbRow({ cf_database_id: 'db-uuid' }))
    expect(r.ok && r.target).toEqual({ kind: 'http', databaseId: 'db-uuid' })
  })

  it('refuses the application database', () => {
    const r = resolveQueryTarget(envWithAppDb, dbRow({ cf_database_id: 'app-uuid' }))
    expect(r.ok).toBe(false)
    expect(!r.ok && r.error).toContain('application database')
  })

  it('allows the application database when ALLOW_APP_DB_AS_TARGET is enabled', () => {
    const env = { ...envWithAppDb, ALLOW_APP_DB_AS_TARGET: 'true' } as unknown as Env
    const r = resolveQueryTarget(env, dbRow({ cf_database_id: 'app-uuid' }))
    expect(r.ok && r.target).toEqual({ kind: 'http', databaseId: 'app-uuid' })
  })

  it('refuses the application database for any other switch value', () => {
    for (const value of ['false', 'yes', '1', '']) {
      const env = { ...envWithAppDb, ALLOW_APP_DB_AS_TARGET: value } as unknown as Env
      const r = resolveQueryTarget(env, dbRow({ cf_database_id: 'app-uuid' }))
      expect(r.ok).toBe(false)
      expect(!r.ok && r.error).toContain('application database')
    }
  })

  it('fails closed on the application database when ZETA_APP_DB_ID is missing, even with the switch on', () => {
    const noAppId = { ...env, ALLOW_APP_DB_AS_TARGET: 'true' } as unknown as Env
    const r = resolveQueryTarget(noAppId, dbRow({ cf_database_id: 'db-uuid' }))
    expect(r.ok).toBe(false)
    expect(!r.ok && r.error).toContain('ZETA_APP_DB_ID')
  })

  it('fails closed when ZETA_APP_DB_ID is not configured', () => {
    const r = resolveQueryTarget(env, dbRow({ cf_database_id: 'db-uuid' }))
    expect(r.ok).toBe(false)
    expect(!r.ok && r.error).toContain('ZETA_APP_DB_ID')
  })

  it('rejects a row without a cf_database_id as not linked', () => {
    const r = resolveQueryTarget(envWithAppDb, dbRow({ cf_database_id: null, binding_name: 'QUERY_DB_1' }))
    expect(r.ok).toBe(false)
    expect(!r.ok && r.error).toContain('not linked')
  })
})
