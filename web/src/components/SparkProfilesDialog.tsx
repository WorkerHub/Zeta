import { Plus } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useLocale } from '../hooks/useLocale'
import { ApiError, sparkProfilesApi } from '../lib/api'
import { errorCodeText } from '../lib/error-copy'
import { validateProfileEntry } from '../lib/spark-profile'
import type { ProfileEntry, SparkProfile } from '../types'
import ConfirmDialog from './ConfirmDialog'
import Dialog from './Dialog'
import KeyValueEditor from './KeyValueEditor'

// A new profile being drafted: not yet an id on the server.
const NEW = 'new'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  databaseId: string
  profiles: SparkProfile[]
  /** The connection selection (§5.3) — the dialog's left list and this are one per-target state. */
  selectedProfileId: string | null
  onSelectProfile: (profileId: string | null) => void
  /** Reload the profile list after a save/delete. */
  onSaved: () => void
}

/** The entry the editor is currently showing: the built-in default (null), a saved profile, or a new draft. */
type Editing = string | typeof NEW | null

const EMPTY_ROW: ProfileEntry = { key: '', value: '' }
const KEY_PLACEHOLDER = 'spark.sql.shuffle.partitions'
const VALUE_PLACEHOLDER = '200'

/**
 * The manage-config dialog (§7.3): a left list (built-in "default" pinned on top + the caller's
 * profiles + "+ New") and a right editor (name + the shared key-value row editor). Selecting an
 * item also picks it for connection (§5.3); the built-in default is shown disabled. Validation
 * errors land inline (name, or the offending row); delete is a second-confirmed step.
 */
export default function SparkProfilesDialog({
  open,
  onOpenChange,
  databaseId,
  profiles,
  selectedProfileId,
  onSelectProfile,
  onSaved,
}: Props) {
  const { t } = useLocale()
  const [editingId, setEditingId] = useState<Editing>(null)
  const [name, setName] = useState('')
  const [rows, setRows] = useState<ProfileEntry[]>([EMPTY_ROW])
  const [nameError, setNameError] = useState<string | null>(null)
  const [serverErrors, setServerErrors] = useState<Record<string, string>>({})
  const [dialogError, setDialogError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)

  const isDefault = editingId === null

  // On open, land on the current connection selection (the default when none is picked).
  // biome-ignore lint/correctness/useExhaustiveDependencies: open is the trigger, not an input
  useEffect(() => {
    if (!open) return
    loadInto(selectedProfileId ?? null)
  }, [open])

  function loadInto(id: Editing) {
    setEditingId(id)
    setNameError(null)
    setServerErrors({})
    setDialogError(null)
    if (id === null || id === NEW) {
      setName('')
      setRows(id === NEW ? [EMPTY_ROW] : [])
      return
    }
    const p = profiles.find((x) => x.id === id)
    setName(p?.name ?? '')
    setRows(p && p.entries.length > 0 ? p.entries.map((e) => ({ key: e.key, value: e.value })) : [EMPTY_ROW])
  }

  function handleSelect(id: string | null) {
    loadInto(id)
    onSelectProfile(id)
  }

  function handleNew() {
    loadInto(NEW)
  }

  // One injected validator for the row editor (§5.2): key shape, startup-level block, lengths, and
  // duplicates within the profile.
  const validateRow = (row: ProfileEntry, all: ProfileEntry[]): string | null => {
    const err = validateProfileEntry(row.key, row.value)
    if (err) {
      return err.code === 'startup_key_in_profile'
        ? t('spark_error.startup_key_in_profile', { key: err.key })
        : t('spark_error.invalid_key', { key: err.key || '…' })
    }
    const k = row.key.trim()
    if (k && all.filter((r) => r.key.trim() === k).length > 1) {
      return t('spark_error.invalid_key', { key: k })
    }
    return null
  }

  const cleanedEntries = (): ProfileEntry[] =>
    rows
      .filter((r) => r.key.trim() !== '' || r.value.trim() !== '')
      .map((r) => ({ key: r.key.trim(), value: r.value.trim() }))

  async function save() {
    setDialogError(null)
    setNameError(null)
    setServerErrors({})

    const trimmedName = name.trim()
    if (!trimmedName) {
      setNameError(t('spark.name_required'))
      return
    }
    const entries = cleanedEntries()
    setSaving(true)
    try {
      if (editingId === NEW) {
        const created = await sparkProfilesApi.create(databaseId, { name: trimmedName, entries })
        onSaved()
        onSelectProfile(created.id)
        setEditingId(created.id)
        setName(created.name)
        setRows(created.entries.length > 0 ? created.entries : [EMPTY_ROW])
      } else if (editingId !== null) {
        await sparkProfilesApi.update(databaseId, editingId, { name: trimmedName, entries })
        onSaved()
      }
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.body.code === 'startup_key_in_profile' || err.body.code === 'invalid_key') {
          const key = typeof err.body.key === 'string' ? err.body.key : ''
          setServerErrors((prev) => ({ ...prev, [key]: errorCodeText(t, err.body) ?? err.message }))
        } else if (typeof err.body.name === 'string') {
          setNameError(t('spark.name_taken'))
        } else {
          setDialogError(err.message)
        }
      } else {
        setDialogError(err instanceof Error ? err.message : t('errors.save_failed'))
      }
    } finally {
      setSaving(false)
    }
  }

  async function confirmDelete() {
    if (editingId === null || editingId === NEW) return
    setDeletingId(editingId)
  }

  async function doDelete() {
    const id = deletingId
    if (!id) return
    setDeleting(true)
    try {
      await sparkProfilesApi.remove(databaseId, id)
      onSaved()
      if (selectedProfileId === id) onSelectProfile(null)
      loadInto(null)
    } catch (err) {
      setDialogError(err instanceof Error ? err.message : t('errors.delete_db_failed'))
    } finally {
      setDeleting(false)
      setDeletingId(null)
    }
  }

  const listItemClass = (active: boolean) =>
    `w-full rounded-md px-2.5 py-2 text-left text-body transition-colors duration-(--duration-fast) ${
      active ? 'bg-brand-50 text-brand-700 dark:text-brand-400 font-medium' : 'text-ink-700 hover:bg-ink-100'
    }`

  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={t('spark.dialog_title')} className="max-w-2xl">
      <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
        {/* Left: the selectable list */}
        <div className="flex shrink-0 flex-col border-b border-ink-200 sm:w-56 sm:border-b-0 sm:border-r">
          <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto p-2">
            <button type="button" onClick={() => handleSelect(null)} className={listItemClass(isDefault)}>
              <span className="block truncate">{t('spark.default_profile')}</span>
            </button>
            {profiles.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => handleSelect(p.id)}
                className={listItemClass(editingId === p.id)}
              >
                <span className="block truncate">{p.name}</span>
              </button>
            ))}
          </div>
          <div className="border-t border-ink-200 p-2">
            <button type="button" onClick={handleNew} className="btn-ghost btn-sm w-full justify-start">
              <Plus size={13} aria-hidden="true" />
              {t('spark.new_profile')}
            </button>
          </div>
        </div>

        {/* Right: name + row editor */}
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
            {dialogError && <p className="text-caption text-danger-600">{dialogError}</p>}
            <div>
              <label className="label" htmlFor="spark-profile-name">
                {t('spark.name')}
              </label>
              <input
                id="spark-profile-name"
                value={isDefault ? t('spark.default_profile') : name}
                onChange={(e) => {
                  setName(e.target.value)
                  setNameError(null)
                }}
                disabled={isDefault}
                className="input"
              />
              {nameError && <p className="mt-1 text-micro text-danger-600">{nameError}</p>}
            </div>
            <KeyValueEditor
              rows={rows}
              onChange={setRows}
              validate={validateRow}
              serverErrors={serverErrors}
              placeholders={{ key: KEY_PLACEHOLDER, value: VALUE_PLACEHOLDER }}
              disabled={isDefault}
            />
          </div>

          {/* Footer */}
          <div className="flex shrink-0 items-center justify-between gap-3 border-t border-ink-200 px-4 py-3">
            <button
              type="button"
              onClick={confirmDelete}
              disabled={isDefault || editingId === NEW}
              className="btn-danger"
            >
              {t('spark.delete_profile')}
            </button>
            <div className="flex gap-2">
              <button type="button" onClick={() => onOpenChange(false)} className="btn-secondary">
                {t('common.cancel')}
              </button>
              <button type="button" onClick={save} disabled={isDefault || saving} className="btn-primary">
                {t('spark.save')}
              </button>
            </div>
          </div>
        </div>
      </div>

      {deletingId && (
        <ConfirmDialog
          title={t('spark.delete_confirm_title')}
          description={t('spark.delete_confirm_desc')}
          confirmLabel={t('common.delete')}
          busy={deleting}
          onCancel={() => setDeletingId(null)}
          onConfirm={doDelete}
        />
      )}
    </Dialog>
  )
}
