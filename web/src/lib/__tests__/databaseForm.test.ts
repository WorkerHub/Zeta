import { describe, it, expect } from 'vitest'
import {
  canSaveForm,
  connectionPatch,
  connectionTouched,
  providerPrefill,
  sparkLivyPairValid,
  sparkLivyTouched,
  sparkUiPairValid,
  sparkUiTouched,
} from '../database-form'
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

describe('sparkUiTouched', () => {
  it('is false when neither UI field is filled', () => {
    expect(sparkUiTouched(untouched)).toBe(false)
    expect(sparkUiTouched({ ...untouched, uiUrl: '   ', uiPlatformToken: '' })).toBe(false)
  })

  it('is true when either UI field has text', () => {
    expect(sparkUiTouched({ ...untouched, uiUrl: 'https://ui.example.com' })).toBe(true)
    expect(sparkUiTouched({ ...untouched, uiPlatformToken: 'token' })).toBe(true)
  })
})

describe('sparkLivyTouched', () => {
  it('is false when neither Livy field is filled', () => {
    expect(sparkLivyTouched(untouched)).toBe(false)
    expect(sparkLivyTouched({ ...untouched, livyUrl: '   ', livyPlatformToken: '' })).toBe(false)
  })

  it('is true when either Livy field has text', () => {
    expect(sparkLivyTouched({ ...untouched, livyUrl: 'https://livy.example.com' })).toBe(true)
    expect(sparkLivyTouched({ ...untouched, livyPlatformToken: 'token' })).toBe(true)
  })
})

describe('sparkUiPairValid', () => {
  it('is true when both are empty or undefined', () => {
    expect(sparkUiPairValid()).toBe(true)
    expect(sparkUiPairValid('', '')).toBe(true)
    expect(sparkUiPairValid('   ', '  ')).toBe(true)
  })

  it('is true when both are provided', () => {
    expect(sparkUiPairValid('https://ui.example.com', 'ui-token')).toBe(true)
  })

  it('is false when only one is provided', () => {
    expect(sparkUiPairValid('https://ui.example.com', '')).toBe(false)
    expect(sparkUiPairValid('', 'ui-token')).toBe(false)
    expect(sparkUiPairValid('https://ui.example.com', '   ')).toBe(false)
  })
})

describe('sparkLivyPairValid', () => {
  it('is true when both are empty or undefined', () => {
    expect(sparkLivyPairValid()).toBe(true)
    expect(sparkLivyPairValid('', '')).toBe(true)
    expect(sparkLivyPairValid('   ', '  ')).toBe(true)
  })

  it('is true when both are provided', () => {
    expect(sparkLivyPairValid('https://livy.example.com', 'livy-token')).toBe(true)
  })

  it('is false when only one is provided', () => {
    expect(sparkLivyPairValid('https://livy.example.com', '')).toBe(false)
    expect(sparkLivyPairValid('', 'livy-token')).toBe(false)
    expect(sparkLivyPairValid('https://livy.example.com', '   ')).toBe(false)
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

  it('will not save a Spark target when Spark UI fields are only partly filled in', () => {
    const sparkValues = { url: 'https://spark.example.com', platformToken: 'p', appToken: 'a' }
    const signature = tested(sparkValues, 'spark')
    const base = {
      mode: 'add' as const,
      kind: 'spark' as const,
      name: 'Spark',
      cfDatabaseId: '',
      testedSignature: signature,
    }

    // Both empty: fine
    expect(canSaveForm({ ...base, values: sparkValues })).toBe(true)
    // Both filled: fine
    expect(
      canSaveForm({
        ...base,
        values: { ...sparkValues, uiUrl: 'https://ui.example.com', uiPlatformToken: 'ui-token' },
      })
    ).toBe(true)
    // Only uiUrl: refused
    expect(
      canSaveForm({
        ...base,
        values: { ...sparkValues, uiUrl: 'https://ui.example.com', uiPlatformToken: '' },
      })
    ).toBe(false)
    // Only uiPlatformToken: refused
    expect(
      canSaveForm({
        ...base,
        values: { ...sparkValues, uiUrl: '', uiPlatformToken: 'ui-token' },
      })
    ).toBe(false)
  })

  it('allows saving updated Spark UI fields in edit mode without re-testing unchanged connection', () => {
    const args = {
      mode: 'edit' as const,
      kind: 'spark' as const,
      name: 'Spark',
      cfDatabaseId: '',
      values: { ...untouched, uiUrl: 'https://ui.example.com', uiPlatformToken: 'ui-token' },
      testedSignature: null,
    }
    expect(canSaveForm(args)).toBe(true)

    // Refuses if UI fields are partly filled in edit mode
    expect(canSaveForm({ ...args, values: { ...untouched, uiUrl: 'https://ui.example.com' } })).toBe(false)
  })

  it('enforces that Spark Livy fields must travel as a pair', () => {
    const sparkValues = {
      url: 'https://spark.example.com',
      platformToken: 'p',
      appToken: 'a',
    }
    const base = {
      mode: 'add' as const,
      kind: 'spark' as const,
      name: 'Spark',
      cfDatabaseId: '',
      testedSignature: tested(sparkValues, 'spark'),
    }

    // Both empty: fine
    expect(canSaveForm({ ...base, values: sparkValues })).toBe(true)
    // Both filled: fine
    expect(
      canSaveForm({
        ...base,
        values: { ...sparkValues, livyUrl: 'https://livy.example.com', livyPlatformToken: 'livy-token' },
      })
    ).toBe(true)
    // Only livyUrl: refused
    expect(
      canSaveForm({
        ...base,
        values: { ...sparkValues, livyUrl: 'https://livy.example.com', livyPlatformToken: '' },
      })
    ).toBe(false)
    // Only livyPlatformToken: refused
    expect(
      canSaveForm({
        ...base,
        values: { ...sparkValues, livyUrl: '', livyPlatformToken: 'livy-token' },
      })
    ).toBe(false)
  })

  it('allows saving updated Spark Livy fields in edit mode without re-testing unchanged connection', () => {
    const args = {
      mode: 'edit' as const,
      kind: 'spark' as const,
      name: 'Spark',
      cfDatabaseId: '',
      values: { ...untouched, livyUrl: 'https://livy.example.com', livyPlatformToken: 'livy-token' },
      testedSignature: null,
    }
    expect(canSaveForm(args)).toBe(true)

    // Refuses if Livy fields are partly filled in edit mode
    expect(canSaveForm({ ...args, values: { ...untouched, livyUrl: 'https://livy.example.com' } })).toBe(false)
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

  it('includes trimmed ui_url and ui_platform_token when both are present', () => {
    expect(
      connectionPatch('spark', {
        url: 'https://spark.example.com',
        platformToken: 'p',
        appToken: 'a',
        uiUrl: ' https://spark-ui.example.com ',
        uiPlatformToken: ' ui-token ',
      })
    ).toEqual({
      connection_url: 'https://spark.example.com',
      platform_token: 'p',
      app_token: 'a',
      ui_url: 'https://spark-ui.example.com',
      ui_platform_token: 'ui-token',
    })
  })

  it('sends only Spark UI fields in edit mode when SQL connection is untouched', () => {
    expect(
      connectionPatch('spark', {
        url: '',
        platformToken: '',
        appToken: '',
        uiUrl: 'https://spark-ui.example.com',
        uiPlatformToken: 'ui-token',
      })
    ).toEqual({
      ui_url: 'https://spark-ui.example.com',
      ui_platform_token: 'ui-token',
    })
  })

  it('returns null when Spark UI fields are partly filled', () => {
    expect(
      connectionPatch('spark', {
        url: 'https://spark.example.com',
        platformToken: 'p',
        appToken: 'a',
        uiUrl: 'https://spark-ui.example.com',
        uiPlatformToken: '',
      })
    ).toBe(null)
  })

  it('includes trimmed livy_url and livy_platform_token when both are present', () => {
    expect(
      connectionPatch('spark', {
        url: 'https://spark.example.com',
        platformToken: 'p',
        appToken: 'a',
        livyUrl: ' https://livy.example.com ',
        livyPlatformToken: ' livy-token ',
      })
    ).toEqual({
      connection_url: 'https://spark.example.com',
      platform_token: 'p',
      app_token: 'a',
      livy_url: 'https://livy.example.com',
      livy_platform_token: 'livy-token',
    })
  })

  it('sends only Livy fields in edit mode when SQL connection is untouched', () => {
    expect(
      connectionPatch('spark', {
        url: '',
        platformToken: '',
        appToken: '',
        livyUrl: 'https://livy.example.com',
        livyPlatformToken: 'livy-token',
      })
    ).toEqual({
      livy_url: 'https://livy.example.com',
      livy_platform_token: 'livy-token',
    })
  })

  it('returns null when Livy fields are partly filled', () => {
    expect(
      connectionPatch('spark', {
        url: 'https://spark.example.com',
        platformToken: 'p',
        appToken: 'a',
        livyUrl: 'https://livy.example.com',
        livyPlatformToken: '',
      })
    ).toBe(null)
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
