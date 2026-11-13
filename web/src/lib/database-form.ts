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

/**
 * The connection part of an edit's PATCH body, or null when every field was left blank (the stored
 * registration stays as it is). Spark's three values travel as one group, so a partial fill yields
 * null — the form's gate already refuses to save that.
 */
export function connectionPatch(
  kind: ConnectionKind,
  values: ConnectionValues
): { connection_url: string; platform_token?: string; app_token?: string } | null {
  if (!connectionTouched(values)) return null
  if (connectionSignature({ kind, ...values }) === null) return null
  return {
    connection_url: values.url.trim(),
    ...(kind === 'spark' ? { platform_token: values.platformToken.trim(), app_token: values.appToken.trim() } : {}),
  }
}
