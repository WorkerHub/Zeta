import { useState, useEffect, useCallback } from 'react'
import { Plus, Trash2, Power, Users, Link2, Pencil, Info } from 'lucide-react'
import { adminApi } from '../../lib/api'
import { useLocale } from '../../hooks/useLocale'
import ConfirmDialog from '../../components/ConfirmDialog'
import DatabaseForm from '../../components/DatabaseForm'
import { effectiveProvider, engineLabelKey } from '../../lib/db-provider'
import type { AdminDatabase, CfD1Database, DatabaseGrant } from '../../types'

// The desktop data-source list is a full-width table: the table stretches to its card (100%), and
// the name column is the one flexible column — a 200px floor, it takes the width the card leaves
// over. The name is plain text and left-aligned, so a wider name column only adds air after the
// text, unlike the database-ID code block, which must not be stretched and keeps its fixed width.
//
// The width lives on a block inside each cell rather than on the `<td>` or a `<col>`: a table cell
// in an automatic layout lets a long value overrule its own width, and `table-layout: fixed` only
// honours column widths when the table itself has a definite width — with `width: auto` the browser
// still sizes the table from its content (measured: a 200px column came out 427px wide). A block
// with a fixed width and its own padding cannot be overruled, so a column measures exactly its
// width. The padding lives on that block for the same reason.
//
// The actions column keeps no width: it is as wide as its buttons, and the extra "Link" button of a
// legacy row simply widens it. Below `md` nothing is pinned — the table keeps its natural columns
// and scrolls horizontally inside its card, as before. Every number is a class literal because
// Tailwind only emits the utilities it can see in the source.
export const COL_WIDTH = {
  // The one flexible column: a 200px floor, it absorbs the card's remaining width on desktop
  name: 'md:min-w-[200px]',
  engine: 'md:w-[140px]',
  provider: 'md:w-[120px]',
  // 268px of content after the 32px padding: a 36-character UUID measures 263.5px in this font, so
  // it shows whole (300 rather than the 320 upper bound this column could have taken)
  databaseId: 'md:w-[300px]',
  // The badge sits against the right edge of this column, which keeps it 32px from the first action
  // button: left-aligned, the air after the badge would be 58px and the 40px budget unreachable
  // without narrowing the column below what the widest badge ("Inactive", 60.8px) needs.
  status: 'md:w-[112px]',
  actions: '',
} as const

// The table's one cell box: the column's width, and the cell padding that belongs with it
export function cellClass(col: keyof typeof COL_WIDTH, extra?: string): string {
  const width = COL_WIDTH[col]
  return ['px-4 py-3', width, extra].filter(Boolean).join(' ')
}

// The database-ID header hint. The project has no tooltip component and no floating-layer
// dependency, so this is the lightweight fallback: a focusable icon whose accessible name and
// native title carry the sentence — no hand-rolled positioning.
export function DatabaseIdHint({ text }: { text: string }) {
  return (
    <button
      type="button"
      aria-label={text}
      title={text}
      className="inline-flex items-center justify-center rounded-sm text-ink-400 transition-colors duration-(--duration-base) ease-(--ease-standard) hover:text-ink-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-600 dark:focus-visible:ring-brand-400"
    >
      <Info size={14} aria-hidden="true" />
    </button>
  )
}

// Rows written before the kind column exist are D1 registrations
const isD1 = (db: AdminDatabase) => (db.kind ?? 'sqlite') === 'sqlite'

// The database-ID cell of one row: the UUID as plain monospaced text (the full ID in its title, no
// tinted code block that painted the rest of the column), a dash for engines that have no database
// ID, or the binding badge of an old registration that still has to be linked.
export function DatabaseIdCell({ db }: { db: AdminDatabase }) {
  const { t } = useLocale()
  if (!isD1(db)) return <span className="text-caption text-ink-400">—</span>
  if (!db.cf_database_id) {
    return <span className="badge badge-neutral">{t('admin_db.legacy_binding', { name: db.binding_name })}</span>
  }
  return (
    <code className="block max-w-full truncate text-caption text-ink-700 font-mono tnum" title={db.cf_database_id}>
      {db.cf_database_id}
    </code>
  )
}

export default function AdminDatabases() {
  const { t } = useLocale()
  const [databases, setDatabases] = useState<AdminDatabase[]>([])
  const [available, setAvailable] = useState<CfD1Database[]>([])
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [showAdd, setShowAdd] = useState(false)
  // The row the registration form is editing, if any (the same form as adding)
  const [editing, setEditing] = useState<AdminDatabase | null>(null)
  const [linking, setLinking] = useState<AdminDatabase | null>(null)
  const [linkCfId, setLinkCfId] = useState('')
  const [linkError, setLinkError] = useState('')
  const [selectedDb, setSelectedDb] = useState<AdminDatabase | null>(null)
  const [permissions, setPermissions] = useState<DatabaseGrant[]>([])
  const [allUsers, setAllUsers] = useState<Array<{ id: string; email: string; name: string }>>([])
  const [permUserId, setPermUserId] = useState('')
  const [permLevel, setPermLevel] = useState('read')
  const [deletingDb, setDeletingDb] = useState<{ id: string; name: string } | null>(null)

  // Runs an admin action and shows its error instead of dropping it
  const attempt = useCallback(
    async (action: () => Promise<void>) => {
      setError('')
      try {
        await action()
      } catch (err) {
        setError(err instanceof Error ? err.message : t('errors.generic'))
      }
    },
    [t]
  )

  const load = useCallback(async () => {
    setLoading(true)
    await attempt(async () => {
      const res = await adminApi.databases()
      setDatabases(res.results)
    })
    setLoading(false)
  }, [attempt])

  useEffect(() => {
    load()
  }, [load])

  // Fetches the account's D1 databases (app DB already excluded) for the add and link pickers.
  async function loadAvailable(): Promise<void> {
    const res = await adminApi.listD1Databases()
    setAvailable(res.results)
  }

  function toggleAdd() {
    const opening = !showAdd
    setShowAdd(opening)
    setEditing(null)
    setError('')
    if (opening) {
      loadAvailable().catch((err) => setError(err instanceof Error ? err.message : t('errors.generic')))
    }
  }

  function startEdit(db: AdminDatabase) {
    setShowAdd(false)
    setEditing(db)
    setError('')
  }

  // The form owns its own state and closes itself; the list re-reads what was saved
  function handleSaved() {
    setShowAdd(false)
    setEditing(null)
    load()
  }

  function closeForm() {
    setShowAdd(false)
    setEditing(null)
  }

  async function startLink(db: AdminDatabase) {
    setLinking(db)
    setLinkCfId('')
    setLinkError('')
    try {
      await loadAvailable()
    } catch (err) {
      setLinkError(err instanceof Error ? err.message : t('errors.generic'))
    }
  }

  async function confirmLink() {
    if (!linking || !linkCfId) return
    setLinkError('')
    try {
      await adminApi.updateDatabase(linking.id, { cf_database_id: linkCfId })
      setLinking(null)
      setLinkCfId('')
      load()
    } catch (err) {
      setLinkError(err instanceof Error ? err.message : t('errors.generic'))
    }
  }

  async function toggleActive(db: AdminDatabase) {
    await attempt(async () => {
      await adminApi.updateDatabase(db.id, { is_active: !db.is_active })
      await load()
    })
  }

  async function deleteDb(id: string) {
    try {
      await adminApi.deleteDatabase(id)
      if (selectedDb?.id === id) setSelectedDb(null)
      if (editing?.id === id) setEditing(null)
      load()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('errors.delete_db_failed'))
    }
  }

  async function fetchPermissions(db: AdminDatabase) {
    setSelectedDb(db)
    // write_drop is never offered for the app database; clamp any stale selection.
    if (db.is_app_db && permLevel === 'write_drop') setPermLevel('write')
    const [perms, users] = await Promise.all([adminApi.getPermissions(db.id), adminApi.users({ limit: 200 })])
    setPermissions(perms.results)
    setAllUsers(users.results.map((u) => ({ id: u.id, email: u.email, name: u.name })))
  }

  const loadPermissions = (db: AdminDatabase) => attempt(() => fetchPermissions(db))

  async function grantPerm() {
    if (!selectedDb || !permUserId) return
    await attempt(async () => {
      await adminApi.setPermission(selectedDb.id, permUserId, permLevel)
      await fetchPermissions(selectedDb)
      setPermUserId('')
    })
  }

  async function revokePerm(userId: string) {
    if (!selectedDb) return
    await attempt(async () => {
      await adminApi.revokePermission(selectedDb.id, userId)
      await fetchPermissions(selectedDb)
    })
  }

  const availableOptions = available.filter((d) => !d.added)
  // Whether the currently picked link target is Zeta's own application database.
  const linkIsApp = linkCfId ? available.some((d) => d.uuid === linkCfId && d.is_app_db) : false

  return (
    <div className="p-4 sm:p-6 max-w-7xl flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <h1 className="text-title text-ink-950">{t('admin.databases')}</h1>
        <button type="button" onClick={toggleAdd} className="btn-primary btn-sm gap-1.5">
          <Plus size={13} /> {t('admin_db.add_database')}
        </button>
      </div>

      {error && <p className="-mt-3 text-body text-danger-600">{error}</p>}

      {/* Add / edit form — one component, prefilled with the row being edited */}
      {(showAdd || editing) && (
        <DatabaseForm
          // A different target needs a different form state, so switching rows remounts it
          key={editing?.id ?? 'add'}
          mode={editing ? 'edit' : 'add'}
          database={editing ?? undefined}
          available={available}
          onSaved={handleSaved}
          onCancel={closeForm}
        />
      )}

      {/* Link (migration) form */}
      {linking && (
        <div className="card p-5 space-y-4">
          <h2 className="text-heading text-ink-900">
            {t('admin_db.link_title')} — <span className="text-ink-700 font-medium">{linking.name}</span>
          </h2>
          <p className="text-caption text-ink-500">{t('admin_db.link_desc')}</p>
          <select className="input" value={linkCfId} onChange={(e) => setLinkCfId(e.target.value)}>
            <option value="">{t('admin_db.select_database')}</option>
            {availableOptions.map((d) => (
              <option key={d.uuid} value={d.uuid}>
                {d.name} ({d.uuid}){d.is_app_db ? ` — ${t('admin_db.app_db_badge')}` : ''}
              </option>
            ))}
          </select>
          {linkIsApp && (
            <p className="mt-2 flex items-center gap-2 text-caption text-warning-600">
              <span className="badge badge-brand">{t('admin_db.app_db_badge')}</span>
              <span>{t('admin_db.app_db_warning')}</span>
            </p>
          )}
          {linkError && <p className="text-body text-danger-600">{linkError}</p>}
          <div className="flex gap-3">
            <button type="button" onClick={() => setLinking(null)} className="btn-secondary">
              {t('admin_db.cancel')}
            </button>
            <button type="button" onClick={confirmLink} className="btn-primary" disabled={!linkCfId}>
              {t('admin_db.link')}
            </button>
          </div>
        </div>
      )}

      {/* Database list */}
      <div className="card overflow-x-auto">
        {loading ? (
          <p className="px-4 py-8 text-center text-body text-ink-500">{t('admin_db.loading')}</p>
        ) : databases.length === 0 ? (
          <p className="px-4 py-8 text-center text-body text-ink-500">{t('admin_db.no_databases')}</p>
        ) : (
          <table className="w-full text-body">
            <thead>
              <tr className="border-b border-ink-200 bg-ink-50">
                <th className="text-left text-label text-ink-500">
                  <div className={cellClass('name')}>{t('admin_db.name')}</div>
                </th>
                <th className="text-left text-label text-ink-500">
                  <div className={cellClass('engine', 'whitespace-nowrap')}>{t('admin_db.engine')}</div>
                </th>
                <th className="text-left text-label text-ink-500">
                  <div className={cellClass('provider', 'whitespace-nowrap')}>{t('admin_db.provider')}</div>
                </th>
                <th className="text-left text-label text-ink-500 hidden md:table-cell">
                  <div className={cellClass('databaseId', 'whitespace-nowrap')}>
                    <span className="inline-flex items-center gap-1.5">
                      {t('admin_db.cf_database_id')}
                      <DatabaseIdHint text={t('admin_db.cf_database_id_hint')} />
                    </span>
                  </div>
                </th>
                <th className="text-left text-label text-ink-500">
                  <div className={cellClass('status', 'whitespace-nowrap text-right')}>{t('admin_db.status')}</div>
                </th>
                <th>
                  <div className={cellClass('actions', 'pr-2')} />
                </th>
              </tr>
            </thead>
            <tbody>
              {databases.map((db) => (
                <tr
                  key={db.id}
                  className="border-b border-ink-100 hover:bg-ink-50 transition-colors duration-(--duration-base)"
                >
                  <td>
                    <div className={cellClass('name')}>
                      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-body-strong text-ink-900">
                        <span className="min-w-0 truncate" title={db.name}>
                          {db.name}
                        </span>
                        {db.is_app_db && (
                          <span className="badge badge-brand shrink-0">{t('admin_db.app_db_badge')}</span>
                        )}
                      </p>
                      {db.description && (
                        <p className="line-clamp-2 text-caption text-ink-500" title={db.description}>
                          {db.description}
                        </p>
                      )}
                    </div>
                  </td>
                  <td>
                    <div className={cellClass('engine', 'whitespace-nowrap text-ink-700')}>
                      {t(engineLabelKey(db.kind))}
                    </div>
                  </td>
                  <td>
                    <div
                      className={cellClass('provider', 'whitespace-nowrap text-ink-700 truncate')}
                      title={effectiveProvider(db.kind, db.provider) ?? undefined}
                    >
                      {effectiveProvider(db.kind, db.provider) ?? '—'}
                    </div>
                  </td>
                  <td className="hidden md:table-cell">
                    <div className={cellClass('databaseId', 'whitespace-nowrap')}>
                      <DatabaseIdCell db={db} />
                    </div>
                  </td>
                  <td>
                    <div className={cellClass('status', 'whitespace-nowrap text-right')}>
                      <span className={`badge ${db.is_active ? 'badge-green' : 'badge-neutral'}`}>
                        {db.is_active ? t('admin_db.active') : t('admin_db.inactive')}
                      </span>
                    </div>
                  </td>
                  <td>
                    {/* 8px on the right, not 16: the delete button carries its own, and the
                        whole table then stays inside the card at 1440 in Chinese */}
                    <div className={cellClass('actions', 'whitespace-nowrap pr-2')}>
                      <div className="flex items-center gap-1">
                        <button type="button" onClick={() => startEdit(db)} className="btn-ghost btn-sm gap-1">
                          <Pencil size={13} /> {t('admin_db.edit')}
                        </button>
                        {isD1(db) && !db.cf_database_id && (
                          <button
                            type="button"
                            onClick={() => startLink(db)}
                            className="btn-ghost btn-sm gap-1"
                            title={t('admin_db.link')}
                          >
                            <Link2 size={13} /> {t('admin_db.link')}
                          </button>
                        )}
                        <button type="button" onClick={() => loadPermissions(db)} className="btn-ghost btn-sm gap-1">
                          <Users size={13} /> {t('admin_db.permissions')}
                        </button>
                        <button
                          type="button"
                          onClick={() => toggleActive(db)}
                          className="btn-ghost btn-sm p-1.5"
                          title={t('admin_db.toggle_active')}
                        >
                          <Power size={13} className={db.is_active ? 'text-success-600' : 'text-ink-400'} />
                        </button>
                        <button
                          type="button"
                          onClick={() => setDeletingDb({ id: db.id, name: db.name })}
                          className="btn-ghost btn-sm p-1.5 text-danger-600"
                        >
                          <Trash2 size={13} />
                        </button>
                      </div>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Permissions panel */}
      {selectedDb && (
        <div className="card p-5">
          <h2 className="text-heading text-ink-900 mb-4 flex flex-wrap items-center gap-2">
            <span>
              {t('admin_db.permissions_for')} <span className="text-ink-700 font-medium">{selectedDb.name}</span>
            </span>
            {selectedDb.is_app_db && <span className="badge badge-brand">{t('admin_db.app_db_badge')}</span>}
          </h2>
          <p className="text-caption text-ink-500 mb-4">{t('admin_db.perm_note')}</p>
          {selectedDb.is_app_db && <p className="mb-4 text-caption text-warning-600">{t('admin_db.app_db_warning')}</p>}

          {/* Grant form */}
          <div className="flex gap-2 mb-4 flex-wrap">
            <select
              value={permUserId}
              onChange={(e) => setPermUserId(e.target.value)}
              className="input flex-1 min-w-[180px]"
            >
              <option value="">{t('admin_db.select_user')}</option>
              {allUsers
                .filter((u) => !permissions.some((p) => p.user_id === u.id))
                .map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name} ({u.email})
                  </option>
                ))}
            </select>
            <select value={permLevel} onChange={(e) => setPermLevel(e.target.value)} className="input w-52">
              <option value="read">{t('admin_db.perm_read')}</option>
              <option value="write">{t('admin_db.perm_write')}</option>
              {!selectedDb.is_app_db && <option value="write_drop">{t('admin_db.perm_write_drop')}</option>}
            </select>
            <button type="button" onClick={grantPerm} disabled={!permUserId} className="btn-primary btn-sm">
              {t('admin_db.grant')}
            </button>
          </div>

          {/* Current permissions */}
          {permissions.length === 0 ? (
            <p className="text-body text-ink-500">{t('admin_db.no_permissions')}</p>
          ) : (
            <ul className="space-y-2">
              {permissions.map((p) => (
                <li key={p.id} className="flex items-center justify-between bg-ink-100 rounded-lg px-4 py-2.5">
                  <div>
                    <p className="text-body-strong text-ink-900">{p.user_name}</p>
                    <p className="text-caption text-ink-500">{p.email}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <span
                      className={`badge ${p.permission === 'write_drop' ? 'badge-yellow' : p.permission === 'write' ? 'badge-brand' : 'badge-neutral'}`}
                    >
                      {p.permission === 'write_drop'
                        ? t('admin_db.perm_write_drop')
                        : p.permission === 'write'
                          ? t('admin_db.perm_write')
                          : t('admin_db.perm_read')}
                    </span>
                    <button
                      type="button"
                      onClick={() => revokePerm(p.user_id)}
                      className="btn-ghost p-1.5 text-danger-600 btn-sm"
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {/* Delete confirmation (design-system dialog; error surfaces in the page banner) */}
      {deletingDb && (
        <ConfirmDialog
          title={t('admin_db.confirm_delete').replace('{name}', deletingDb.name)}
          description={t('admin_db.confirm_delete_desc')}
          confirmLabel={t('common.delete')}
          onCancel={() => setDeletingDb(null)}
          onConfirm={() => {
            const target = deletingDb
            setDeletingDb(null)
            setError('')
            deleteDb(target.id)
          }}
        />
      )}
    </div>
  )
}
