// The registration form's rules, kept out of the component so they can be tested without a DOM:
// what needs a live test before saving, and what an edit actually sends.
//
// A pasted-value target (PostgreSQL, MySQL/TiDB Cloud Starter, SparkSQL) is proven by a live test
// when it is registered. Editing one re-tests only while its pasted values are being replaced —
// the stored values never come back, so the edit form's fields start blank and blank means "keep
// what is stored". Name, description and provider alone never trigger a test.

import { canSaveConnection, connectionSignature, isConnectionKind } from './connection-string'
import type { ConnectionKind } from './connection-string'
import type { DbKind } from '../types'

export type FormMode = 'add' | 'edit'

export interface ConnectionValues {
  /** Connection string for the SQL engines, the service's publish address for Spark. */
  url: string
  /** Spark only: the publish address' platform token. */
  platformToken: string
  /** Spark only: the service's app token. */
  appToken: string
  /** Spark only: optional Spark UI publish address. */
  uiUrl?: string
  /** Spark only: optional Spark UI platform token. */
  uiPlatformToken?: string
  /** Spark only: optional Livy publish address. */
  livyUrl?: string
  /** Spark only: optional Livy platform token. */
  livyPlatformToken?: string
}

/**
 * What the edit form's Provider box starts with: the admin's own text, never the effective value.
 * The API sends both — `provider_custom` is what was typed, `provider` is that or the derived
 * "Neon"/"TiDB"/"D1". Prefilling from the latter would make every target look customised, and
 * saving it would then freeze the derived name into the registration.
 */
export function providerPrefill(database?: { provider_custom?: string | null }): string {
  return database?.provider_custom ?? ''
}

/** Whether the admin typed any pasted value at all — the only thing that needs a test again. */
export function connectionTouched(values: ConnectionValues): boolean {
  return [values.url, values.platformToken, values.appToken].some((value) => value.trim() !== '')
}

/** Whether the admin typed any Spark UI field. */
export function sparkUiTouched(values: ConnectionValues): boolean {
  return [values.uiUrl, values.uiPlatformToken].some((v) => (v?.trim() ?? '') !== '')
}

/** Whether the admin typed any Livy field. */
export function sparkLivyTouched(values: ConnectionValues): boolean {
  return [values.livyUrl, values.livyPlatformToken].some((v) => (v?.trim() ?? '') !== '')
}

/**
 * Spark UI publish address and platform token travel as a pair: both filled, or both left blank.
 * Filling only one is an incomplete pair that the server refuses with 400.
 */
export function sparkUiPairValid(uiUrl?: string, uiPlatformToken?: string): boolean {
  const u = uiUrl?.trim() ?? ''
  const p = uiPlatformToken?.trim() ?? ''
  return (u === '' && p === '') || (u !== '' && p !== '')
}

/**
 * Livy publish address and platform token travel as a pair: both filled, or both left blank.
 * Filling only one is an incomplete pair that the server refuses with 400.
 */
export function sparkLivyPairValid(livyUrl?: string, livyPlatformToken?: string): boolean {
  const u = livyUrl?.trim() ?? ''
  const p = livyPlatformToken?.trim() ?? ''
  return (u === '' && p === '') || (u !== '' && p !== '')
}

/** Whether the form may save, for the engine it currently holds. */
export function canSaveForm(args: {
  mode: FormMode
  kind: DbKind
  name: string
  cfDatabaseId: string
  values: ConnectionValues
  testedSignature: string | null
}): boolean {
  const { mode, kind, name, cfDatabaseId, values, testedSignature } = args
  // A PATCH only carries a name when it has one; an edit without a name has nothing to save
  if (mode === 'edit' && name.trim() === '') return false

  if (kind === 'spark' && !sparkUiPairValid(values.uiUrl, values.uiPlatformToken)) {
    return false
  }
  if (kind === 'spark' && !sparkLivyPairValid(values.livyUrl, values.livyPlatformToken)) {
    return false
  }

  if (!isConnectionKind(kind)) {
    // A D1 target is registered by picking an account database; editing keeps its link
    return mode === 'edit' || cfDatabaseId !== ''
  }

  const signature = connectionSignature({
    kind,
    url: values.url,
    platformToken: values.platformToken,
    appToken: values.appToken,
  })
  if (mode === 'add') return canSaveConnection(signature, testedSignature)
  return !connectionTouched(values) || canSaveConnection(signature, testedSignature)
}

export interface ConnectionPatch {
  connection_url?: string
  platform_token?: string
  app_token?: string
  ui_url?: string
  ui_platform_token?: string
  livy_url?: string
  livy_platform_token?: string
}

/**
 * The connection part of an edit's PATCH body, or null when every field was left blank (the stored
 * registration stays as it is). Spark's three connection values travel as one group, and its two
 * optional UI values travel as another group; a partial fill in either group yields null — the form's
 * gate already refuses to save that.
 */
export function connectionPatch(kind: ConnectionKind, values: ConnectionValues): ConnectionPatch | null {
  const touched = connectionTouched(values)
  const uiTouched = kind === 'spark' && sparkUiTouched(values)
  const livyTouched = kind === 'spark' && sparkLivyTouched(values)

  if (!touched && !uiTouched && !livyTouched) return null
  if (touched && connectionSignature({ kind, ...values }) === null) return null
  if (uiTouched && !sparkUiPairValid(values.uiUrl, values.uiPlatformToken)) return null
  if (livyTouched && !sparkLivyPairValid(values.livyUrl, values.livyPlatformToken)) return null

  const result: ConnectionPatch = {}

  if (touched) {
    result.connection_url = values.url.trim()
    if (kind === 'spark') {
      result.platform_token = values.platformToken.trim()
      result.app_token = values.appToken.trim()
    }
  }

  if (uiTouched && values.uiUrl && values.uiPlatformToken) {
    result.ui_url = values.uiUrl.trim()
    result.ui_platform_token = values.uiPlatformToken.trim()
  }

  if (livyTouched && values.livyUrl && values.livyPlatformToken) {
    result.livy_url = values.livyUrl.trim()
    result.livy_platform_token = values.livyPlatformToken.trim()
  }

  return result
}
