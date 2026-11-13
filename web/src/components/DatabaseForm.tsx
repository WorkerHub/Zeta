import { useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { adminApi, ApiError } from '../lib/api'
import { useLocale } from '../hooks/useLocale'
import ConnectionStringFields from './ConnectionStringFields'
import { connectionSignature, describeTestResult, isConnectionKind } from '../lib/connection-string'
import type { ConnectionTestState } from '../lib/connection-string'
import { canSaveForm, connectionPatch, connectionTouched, providerPrefill } from '../lib/database-form'
import type { FormMode } from '../lib/database-form'
import { engineLabelKey } from '../lib/db-provider'
import { errorCodeText } from '../lib/error-copy'
import type { AdminDatabase, CfD1Database, DbKind } from '../types'

// Title and description of the registration card, per engine.
function registerCopy(kind: DbKind): { title: string; desc: string } {
  switch (kind) {
    case 'postgres':
      return { title: 'admin_db.register_title_pg', desc: 'admin_db.register_desc_pg' }
    case 'mysql':
      return { title: 'admin_db.register_title_mysql', desc: 'admin_db.register_desc_mysql' }
    case 'spark':
      return { title: 'admin_db.register_title_spark', desc: 'admin_db.register_desc_spark' }
    default:
      return { title: 'admin_db.register_title', desc: 'admin_db.register_desc' }
  }
}

interface Props {
  mode: FormMode
  /** The row being edited; ignored when adding. */
  database?: AdminDatabase
  /** The account's D1 databases (app database already excluded), for the add picker. */
  available: CfD1Database[]
  onSaved: () => void
  onCancel: () => void
}

/**
 * The one registration form, used to add a data source and to edit an existing one.
 *
 * Adding a pasted-value target is gated on a live test of exactly the values being submitted.
 * Editing is gated the same way only while those values change: the stored ones never come back
 * (lib/api.ts returns no secrets), so the fields start blank and blank means "keep what is stored" —
 * renaming a data source, or correcting its provider, saves without a test.
 */
export default function DatabaseForm({ mode, database, available, onSaved, onCancel }: Props) {
  const { t } = useLocale()
  const editing = mode === 'edit'
  const [addKind, setAddKind] = useState<DbKind>('sqlite')
  // The engine is fixed once a target exists: what is registered is what is tested and executed
  const activeKind: DbKind = editing ? (database?.kind ?? 'sqlite') : addKind

  const [name, setName] = useState(editing ? (database?.name ?? '') : '')
  const [description, setDescription] = useState(database?.description ?? '')
  const [provider, setProvider] = useState(providerPrefill(database))
  const [cfDatabaseId, setCfDatabaseId] = useState('')
  const [url, setUrl] = useState('')
  const [platformToken, setPlatformToken] = useState('')
  const [appToken, setAppToken] = useState('')
  const [testState, setTestState] = useState<ConnectionTestState>('idle')
  const [testedSignature, setTestedSignature] = useState<string | null>(null)
  const [testError, setTestError] = useState('')
  const [testInfo, setTestInfo] = useState('')
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState('')

  // A passing test only vouches for the values it ran against: editing any field or switching
  // engine drops it, so the save button cannot outlive what was actually verified.
  function invalidateTest() {
    setTestState('idle')
    setTestedSignature(null)
    setTestError('')
    setTestInfo('')
  }

  function changeKind(next: DbKind) {
    if (next === addKind) return
    setAddKind(next)
    // Never carry the other engine's input into a submission
    setCfDatabaseId('')
    setUrl('')
    setPlatformToken('')
    setAppToken('')
    invalidateTest()
    setFormError('')
  }

  function changeUrl(next: string) {
    setUrl(next)
    invalidateTest()
  }

  function changePlatformToken(next: string) {
    setPlatformToken(next)
    invalidateTest()
  }

  function changeAppToken(next: string) {
    setAppToken(next)
    invalidateTest()
  }

  async function testConnection() {
    if (testState === 'testing' || !isConnectionKind(activeKind)) return
    const signature = connectionSignature({ kind: activeKind, url, platformToken, appToken })
    if (!signature) return
    setTestState('testing')
    setTestedSignature(null)
    setTestError('')
    setTestInfo('')
    try {
      const res = await adminApi.testConnection({
        connection_url: url.trim(),
        kind: activeKind,
        ...(activeKind === 'spark' ? { platform_token: platformToken.trim(), app_token: appToken.trim() } : {}),
      })
      setTestInfo(describeTestResult(res))
      setTestedSignature(signature)
      setTestState('passed')
    } catch (err) {
      // A classified Spark failure arrives with a code, and the UI has the copy for it; anything
      // else shows the worker's own message (which never contains the pasted secret).
      const message =
        errorCodeText(t, err instanceof ApiError ? err.body : null) ??
        (err instanceof Error ? err.message : t('admin_db.test_failed'))
      setTestError(message)
      setTestState('failed')
    }
  }

  const values = { url, platformToken, appToken }
  const canSave = canSaveForm({
    mode,
    kind: activeKind,
    name,
    cfDatabaseId,
    values,
    testedSignature,
  })
  // The test-first line belongs to the case that needs a test, not to a rename
  const needsTest = isConnectionKind(activeKind) && (editing ? connectionTouched(values) : true)

  async function save() {
    setFormError('')
    setSaving(true)
    try {
      if (editing && database) {
        const patch = isConnectionKind(activeKind) ? connectionPatch(activeKind, values) : null
        await adminApi.updateDatabase(database.id, {
          name: name.trim(),
          description,
          provider: provider.trim(),
          ...(patch ?? {}),
        })
      } else if (isConnectionKind(activeKind)) {
        const patch = connectionPatch(activeKind, values)
        if (!patch) return
        await adminApi.createDatabase({
          kind: activeKind,
          ...patch,
          name: name.trim() || undefined,
          description: description || undefined,
          provider: provider.trim() || undefined,
        })
      } else {
        await adminApi.createDatabase({
          kind: 'sqlite',
          cf_database_id: cfDatabaseId,
          name: name.trim() || undefined,
          description: description || undefined,
          provider: provider.trim() || undefined,
        })
      }
      onSaved()
    } catch (err) {
      setFormError(err instanceof Error ? err.message : t('errors.generic'))
    } finally {
      setSaving(false)
    }
  }

  const availableOptions = available.filter((d) => !d.added)
  // Whether the picked D1 database is Zeta's own application database.
  const pickedIsApp = cfDatabaseId ? available.some((d) => d.uuid === cfDatabaseId && d.is_app_db) : false

  return (
    <div className="card p-5 space-y-4">
      <h2 className="text-heading text-ink-900">
        {editing ? (
          <>
            {t('admin_db.edit_title')} — <span className="font-medium text-ink-700">{database?.name}</span>
          </>
        ) : (
          t(registerCopy(activeKind).title)
        )}
      </h2>
      {!editing && <p className="text-caption text-ink-500">{t(registerCopy(activeKind).desc)}</p>}

      <div className="grid sm:grid-cols-2 gap-4">
        {editing ? (
          <div className="sm:col-span-2">
            <p className="label">{t('admin_db.kind')}</p>
            <p className="text-body text-ink-900">{t(engineLabelKey(activeKind))}</p>
          </div>
        ) : (
          <div className="sm:col-span-2">
            <label htmlFor="db-kind" className="label">
              {t('admin_db.kind')}
            </label>
            <div className="relative">
              <select
                id="db-kind"
                className="input appearance-none pr-9"
                value={addKind}
                onChange={(e) => changeKind(e.target.value as DbKind)}
              >
                <option value="sqlite">{t('admin_db.kind_sqlite')}</option>
                <option value="postgres">{t('admin_db.kind_postgres')}</option>
                <option value="mysql">{t('admin_db.kind_mysql')}</option>
                <option value="spark">{t('admin_db.kind_spark')}</option>
              </select>
              <ChevronDown
                size={14}
                aria-hidden="true"
                className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-ink-400"
              />
            </div>
          </div>
        )}

        {isConnectionKind(activeKind) ? (
          <ConnectionStringFields
            kind={activeKind}
            url={url}
            platformToken={platformToken}
            appToken={appToken}
            editing={editing}
            testState={testState}
            testError={testError}
            testInfo={testInfo}
            onUrlChange={changeUrl}
            onPlatformTokenChange={changePlatformToken}
            onAppTokenChange={changeAppToken}
            onTest={testConnection}
          />
        ) : (
          !editing && (
            <div className="sm:col-span-2">
              <label htmlFor="db-cf" className="label">
                {t('admin_db.cf_database')}
              </label>
              <div className="relative">
                <select
                  id="db-cf"
                  className="input appearance-none pr-9"
                  value={cfDatabaseId}
                  onChange={(e) => setCfDatabaseId(e.target.value)}
                >
                  <option value="">{t('admin_db.select_database')}</option>
                  {availableOptions.map((d) => (
                    <option key={d.uuid} value={d.uuid}>
                      {d.name} ({d.uuid}){d.is_app_db ? ` — ${t('admin_db.app_db_badge')}` : ''}
                    </option>
                  ))}
                </select>
                <ChevronDown
                  size={14}
                  aria-hidden="true"
                  className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-ink-400"
                />
              </div>
              {availableOptions.length === 0 && (
                <p className="mt-1 text-caption text-ink-500">{t('admin_db.no_available')}</p>
              )}
              {pickedIsApp && (
                <p className="mt-2 flex items-center gap-2 text-caption text-warning-600">
                  <span className="badge badge-brand">{t('admin_db.app_db_badge')}</span>
                  <span>{t('admin_db.app_db_warning')}</span>
                </p>
              )}
            </div>
          )
        )}

        <div>
          <label htmlFor="db-display-name" className="label">
            {t('admin_db.display_name')}
          </label>
          <input
            id="db-display-name"
            type="text"
            className="input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('admin_db.name_placeholder')}
          />
        </div>
        <div>
          <label htmlFor="db-description" className="label">
            {t('admin_db.description')}
          </label>
          <input
            id="db-description"
            type="text"
            className="input"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder={t('admin_db.description_placeholder')}
          />
        </div>
        <div>
          <label htmlFor="db-provider" className="label">
            {t('admin_db.provider')}
          </label>
          <input
            id="db-provider"
            type="text"
            className="input"
            value={provider}
            maxLength={40}
            onChange={(e) => setProvider(e.target.value)}
          />
        </div>
      </div>

      {formError && <p className="text-body text-danger-600">{formError}</p>}
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" onClick={onCancel} className="btn-secondary" disabled={saving}>
          {t('admin_db.cancel')}
        </button>
        <button type="button" onClick={save} className="btn-primary" disabled={!canSave || saving}>
          {editing ? t('admin_db.save') : t('admin_db.register')}
        </button>
        {needsTest && !canSave && (
          <p className="text-caption text-ink-500">
            {editing ? t('admin_db.test_before_save_edit') : t('admin_db.test_before_save')}
          </p>
        )}
      </div>
    </div>
  )
}
