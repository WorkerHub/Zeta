import { useState, useEffect, useCallback } from 'react'
import { Plus, Trash2, Power, Users, Link2, ChevronDown } from 'lucide-react'
import { adminApi } from '../../lib/api'
import { useLocale } from '../../hooks/useLocale'
import type { AdminDatabase, CfD1Database, DatabaseGrant } from '../../types'

export default function AdminDatabases() {
  const { t } = useLocale()
  const [databases, setDatabases] = useState<AdminDatabase[]>([])
  const [available, setAvailable] = useState<CfD1Database[]>([])
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [showAdd, setShowAdd] = useState(false)
  const [newDb, setNewDb] = useState({ name: '', description: '', cf_database_id: '' })
  const [addError, setAddError] = useState('')
  const [linking, setLinking] = useState<AdminDatabase | null>(null)
  const [linkCfId, setLinkCfId] = useState('')
  const [linkError, setLinkError] = useState('')
  const [selectedDb, setSelectedDb] = useState<AdminDatabase | null>(null)
  const [permissions, setPermissions] = useState<DatabaseGrant[]>([])
  const [allUsers, setAllUsers] = useState<Array<{ id: string; email: string; name: string }>>([])
  const [permUserId, setPermUserId] = useState('')
  const [permLevel, setPermLevel] = useState('read')

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
    setAddError('')
    if (opening) {
      setNewDb({ name: '', description: '', cf_database_id: '' })
      loadAvailable().catch((err) => setAddError(err instanceof Error ? err.message : t('errors.generic')))
    }
  }

  async function addDatabase() {
    setAddError('')
    try {
      await adminApi.createDatabase({
        cf_database_id: newDb.cf_database_id,
        name: newDb.name || undefined,
        description: newDb.description || undefined,
      })
      setShowAdd(false)
      setNewDb({ name: '', description: '', cf_database_id: '' })
      load()
    } catch (err) {
      setAddError(err instanceof Error ? err.message : t('errors.generic'))
    }
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

  async function deleteDb(id: string, name: string) {
    if (!confirm(t('admin_db.confirm_delete').replace('{name}', name))) return
    try {
      await adminApi.deleteDatabase(id)
      if (selectedDb?.id === id) setSelectedDb(null)
      load()
    } catch (err) {
      alert(err instanceof Error ? err.message : t('errors.delete_db_failed'))
    }
  }

  async function fetchPermissions(db: AdminDatabase) {
    setSelectedDb(db)
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

  return (
    <div className="p-4 sm:p-6 max-w-5xl flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <h1 className="text-title text-ink-950">{t('admin.databases')}</h1>
        <button type="button" onClick={toggleAdd} className="btn-primary btn-sm gap-1.5">
          <Plus size={13} /> {t('admin_db.add_database')}
        </button>
      </div>

      {error && <p className="-mt-3 text-body text-danger-600">{error}</p>}

      {/* Add form */}
      {showAdd && (
        <div className="card p-5 space-y-4">
          <h2 className="text-heading text-ink-900">{t('admin_db.register_title')}</h2>
          <p className="text-caption text-ink-500">{t('admin_db.register_desc')}</p>
          <div className="grid sm:grid-cols-2 gap-4">
            <div className="sm:col-span-2">
              <label htmlFor="db-cf" className="label">
                {t('admin_db.cf_database')}
              </label>
              <div className="relative">
                <select
                  id="db-cf"
                  className="input appearance-none pr-9"
                  value={newDb.cf_database_id}
                  onChange={(e) => setNewDb({ ...newDb, cf_database_id: e.target.value })}
                >
                  <option value="">{t('admin_db.select_database')}</option>
                  {availableOptions.map((d) => (
                    <option key={d.uuid} value={d.uuid}>
                      {d.name} ({d.uuid})
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
            </div>
            <div>
              <label htmlFor="db-display-name" className="label">
                {t('admin_db.display_name')}
              </label>
              <input
                id="db-display-name"
                type="text"
                className="input"
                value={newDb.name}
                onChange={(e) => setNewDb({ ...newDb, name: e.target.value })}
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
                value={newDb.description}
                onChange={(e) => setNewDb({ ...newDb, description: e.target.value })}
                placeholder={t('admin_db.description_placeholder')}
              />
            </div>
          </div>
          {addError && <p className="text-body text-danger-600">{addError}</p>}
          <div className="flex gap-3">
            <button type="button" onClick={() => setShowAdd(false)} className="btn-secondary">
              {t('admin_db.cancel')}
            </button>
            <button type="button" onClick={addDatabase} className="btn-primary" disabled={!newDb.cf_database_id}>
              {t('admin_db.register')}
            </button>
          </div>
        </div>
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
                {d.name} ({d.uuid})
              </option>
            ))}
          </select>
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
                <th className="text-left px-4 py-3 text-label text-ink-500">{t('admin_db.name')}</th>
                <th className="text-left px-4 py-3 text-label text-ink-500 hidden md:table-cell">
                  {t('admin_db.cf_database_id')}
                </th>
                <th className="text-left px-4 py-3 text-label text-ink-500">{t('admin_db.status')}</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {databases.map((db) => (
                <tr
                  key={db.id}
                  className="border-b border-ink-100 hover:bg-ink-50 transition-colors duration-(--duration-base)"
                >
                  <td className="px-4 py-3">
                    <p className="text-body-strong text-ink-900">{db.name}</p>
                    {db.description && <p className="text-caption text-ink-500">{db.description}</p>}
                  </td>
                  <td className="px-4 py-3 hidden md:table-cell">
                    {db.cf_database_id ? (
                      <code className="text-caption text-ink-700 font-mono bg-ink-100 px-1.5 py-0.5 rounded tnum">
                        {db.cf_database_id}
                      </code>
                    ) : (
                      <span className="badge badge-zinc">
                        {t('admin_db.legacy_binding', { name: db.binding_name })}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <span className={`badge ${db.is_active ? 'badge-green' : 'badge-zinc'}`}>
                      {db.is_active ? t('admin_db.active') : t('admin_db.inactive')}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-1 justify-end">
                      {!db.cf_database_id && (
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
                        onClick={() => deleteDb(db.id, db.name)}
                        className="btn-ghost btn-sm p-1.5 text-danger-600"
                      >
                        <Trash2 size={13} />
                      </button>
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
          <h2 className="text-heading text-ink-900 mb-4">
            {t('admin_db.permissions_for')} <span className="text-ink-700 font-medium">{selectedDb.name}</span>
          </h2>
          <p className="text-caption text-ink-500 mb-4">{t('admin_db.perm_note')}</p>

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
              <option value="write_drop">{t('admin_db.perm_write_drop')}</option>
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
                      className={`badge ${p.permission === 'write_drop' ? 'badge-yellow' : p.permission === 'write' ? 'badge-brand' : 'badge-zinc'}`}
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
    </div>
  )
}
