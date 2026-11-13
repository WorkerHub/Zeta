import { describe, it, expect } from 'vitest'
import { canSaveForm, connectionPatch, connectionTouched, providerPrefill } from '../database-form'
import { connectionSignature } from '../connection-string'

const untouched = { url: '', platformToken: '', appToken: '' }
const tested = (
  values: { url: string; platformToken?: string; appToken?: string },
  kind: 'postgres' | 'mysql' | 'spark'
) => connectionSignature({ kind, url: values.url, platformToken: values.platformToken, appToken: values.appToken })

describe('connectionTouched', () => {
  it('is false only while every field is blank', () => {
    expect(connectionTouched(untouched)).toBe(false)
    expect(connectionTouched({ url: '  ', platformToken: '', appToken: '' })).toBe(false)
    expect(connectionTouched({ url: '', platformToken: 'p', appToken: '' })).toBe(true)
  })
})

describe('canSaveForm', () => {
  it('needs a passing test for a new pasted-value target', () => {
    const values = { url: 'postgresql://u:p@host/db', platformToken: '', appToken: '' }
    const base = { mode: 'add' as const, kind: 'postgres' as const, name: '', cfDatabaseId: '', values }
    expect(canSaveForm({ ...base, testedSignature: null })).toBe(false)
    expect(canSaveForm({ ...base, testedSignature: tested(values, 'postgres') })).toBe(true)
  })

  it('needs an account database picked for a new D1 target', () => {
    const base = { mode: 'add' as const, kind: 'sqlite' as const, name: '', values: untouched, testedSignature: null }
    expect(canSaveForm({ ...base, cfDatabaseId: '' })).toBe(false)
    expect(canSaveForm({ ...base, cfDatabaseId: 'uuid' })).toBe(true)
  })

  it('lets a rename of a saved target through without a test', () => {
    const args = {
      mode: 'edit' as const,
      kind: 'postgres' as const,
      name: 'Analytics',
      cfDatabaseId: '',
      values: untouched,
      testedSignature: null,
    }
    expect(canSaveForm(args)).toBe(true)
    expect(canSaveForm({ ...args, name: '   ' })).toBe(false)
  })

  it('demands a test again as soon as the pasted values change', () => {
    const values = { url: 'postgresql://u:p@new/db', platformToken: '', appToken: '' }
    const args = {
      mode: 'edit' as const,
      kind: 'postgres' as const,
      name: 'Analytics',
      cfDatabaseId: '',
      values,
      testedSignature: null,
    }
    expect(canSaveForm(args)).toBe(false)
    expect(canSaveForm({ ...args, testedSignature: tested(values, 'postgres') })).toBe(true)
  })

  it('will not save a Spark target whose three values are only partly filled in', () => {
    const args = {
      mode: 'edit' as const,
      kind: 'spark' as const,
      name: 'Spark',
      cfDatabaseId: '',
      values: { url: 'https://spark.example.com', platformToken: 'p', appToken: '' },
      testedSignature: null,
    }
    expect(canSaveForm(args)).toBe(false)
    // Even with a stale signature that matched something else
    expect(canSaveForm({ ...args, testedSignature: JSON.stringify(['spark']) })).toBe(false)
  })
})

describe('connectionPatch', () => {
  it('sends nothing while the fields stay blank', () => {
    expect(connectionPatch('postgres', untouched)).toBe(null)
  })

  it('sends the trimmed connection string for a SQL engine', () => {
    expect(connectionPatch('mysql', { url: '  mysql://u:p@host/db  ', platformToken: '', appToken: '' })).toEqual({
      connection_url: 'mysql://u:p@host/db',
    })
  })

  it('sends Spark as one group of three, and nothing while it is incomplete', () => {
    expect(connectionPatch('spark', { url: 'https://spark.example.com', platformToken: 'p', appToken: '' })).toBe(null)
    expect(
      connectionPatch('spark', { url: ' https://spark.example.com ', platformToken: ' p ', appToken: ' a ' })
    ).toEqual({ connection_url: 'https://spark.example.com', platform_token: 'p', app_token: 'a' })
  })
})

describe('providerPrefill', () => {
  it("starts from the admin's own text", () => {
    expect(providerPrefill({ provider_custom: 'Aiven' })).toBe('Aiven')
  })

  it('stays empty when nothing was customised, whatever the effective provider says', () => {
    const derivedNeon = { provider: 'Neon', provider_custom: null }
    // An older response may not carry provider_custom at all
    const derivedTiDB: { provider: string; provider_custom?: string | null } = { provider: 'TiDB' }
    expect(providerPrefill(derivedNeon)).toBe('')
    expect(providerPrefill(derivedTiDB)).toBe('')
    expect(providerPrefill(undefined)).toBe('')
  })
})
