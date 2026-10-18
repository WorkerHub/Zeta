import { describe, it, expect } from 'vitest'
import { resolveQueryTarget } from '../bindings'
import type { Env, DatabaseRow } from '../../types'

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
