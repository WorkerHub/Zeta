import { useState, useEffect, useCallback } from 'react'
import { Search, Trash2, CheckCircle, XCircle, X, Pencil, UserPlus } from 'lucide-react'
import { adminApi } from '../../lib/api'
import { useAuthContext } from '../../hooks/useAuth'
import { useLocale } from '../../hooks/useLocale'
import type { User } from '../../types'

type ModalState = { mode: 'create' } | { mode: 'edit'; user: User }

const EMPTY_FORM = { name: '', email: '', password: '', role: 'member' }

export default function AdminUsers() {
  const { user: me } = useAuthContext()
  const { t } = useLocale()
  const [users, setUsers] = useState<User[]>([])
  const [total, setTotal] = useState(0)
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)
  // Errors from loading the list and from row actions (role change, delete)
  const [error, setError] = useState('')
  const [page, setPage] = useState(0)
  const limit = 20

  const [modal, setModal] = useState<ModalState | null>(null)
  const [form, setForm] = useState(EMPTY_FORM)
  const [formError, setFormError] = useState('')
  const [formLoading, setFormLoading] = useState(false)

  const [deleteTarget, setDeleteTarget] = useState<User | null>(null)
  const [deleteLoading, setDeleteLoading] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await adminApi.users({ search, limit, offset: page * limit })
      setUsers(res.results)
      setTotal(res.total)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('errors.generic'))
    } finally {
      setLoading(false)
    }
  }, [search, page, t])

  useEffect(() => {
    load()
  }, [load])

  async function changeRole(id: string, role: string) {
    setError('')
    try {
      await adminApi.updateUser(id, { role })
      load()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('errors.generic'))
    }
  }

  async function deleteUser(id: string) {
    setDeleteLoading(true)
    setError('')
    try {
      await adminApi.deleteUser(id)
      setDeleteTarget(null)
      load()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('errors.delete_user_failed'))
      setDeleteTarget(null)
    } finally {
      setDeleteLoading(false)
    }
  }

  function openCreate() {
    setForm(EMPTY_FORM)
    setFormError('')
    setModal({ mode: 'create' })
  }

  function openEdit(u: User) {
    setForm({ name: u.name, email: u.email, password: '', role: u.role })
    setFormError('')
    setModal({ mode: 'edit', user: u })
  }

  function closeModal() {
    setModal(null)
    setFormError('')
  }

  async function submitModal() {
    setFormError('')
    setFormLoading(true)
    try {
      if (modal?.mode === 'create') {
        await adminApi.createUser({ name: form.name, email: form.email, password: form.password, role: form.role })
      } else if (modal?.mode === 'edit') {
        const patch: Record<string, string> = { name: form.name, email: form.email, role: form.role }
        if (form.password) patch.password = form.password
        await adminApi.updateUser(modal.user.id, patch)
      }
      closeModal()
      load()
    } catch (err) {
      setFormError(err instanceof Error ? err.message : t('errors.generic'))
    } finally {
      setFormLoading(false)
    }
  }

  return (
    <div className="p-4 sm:p-6 max-w-5xl flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <h1 className="text-title text-ink-950">{t('admin.users')}</h1>
        <div className="flex items-center gap-2">
          <span className="badge badge-zinc tnum">
            {total} {t('admin_users.total')}
          </span>
          <button type="button" onClick={openCreate} className="btn-primary btn-sm flex items-center gap-1.5">
            <UserPlus size={13} />
            {t('admin_users.add_user')}
          </button>
        </div>
      </div>

      {error && <p className="-mt-3 text-body text-danger-600">{error}</p>}

      {/* Search */}
      <div className="relative -mt-3">
        <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-400" />
        <input
          type="text"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value)
            setPage(0)
          }}
          className="input pl-9"
          placeholder={t('admin_users.search')}
        />
      </div>

      <div className="card overflow-hidden">
        <table className="w-full text-body">
          <thead>
            <tr className="border-b border-ink-200 bg-ink-50">
              <th className="text-left px-4 py-3 text-label text-ink-500">{t('admin_users.user')}</th>
              <th className="text-left px-4 py-3 text-label text-ink-500 hidden md:table-cell">
                {t('admin_users.verified')}
              </th>
              <th className="text-left px-4 py-3 text-label text-ink-500">{t('admin_users.role')}</th>
              <th className="text-left px-4 py-3 text-label text-ink-500 hidden lg:table-cell">
                {t('admin_users.joined')}
              </th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-body text-ink-500">
                  {t('admin_users.loading')}
                </td>
              </tr>
            ) : users.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-body text-ink-500">
                  {t('admin_users.no_users')}
                </td>
              </tr>
            ) : (
              users.map((u) => (
                <tr
                  key={u.id}
                  className="border-b border-ink-100 hover:bg-ink-50 transition-colors duration-(--duration-base)"
                >
                  <td className="px-4 py-3">
                    <p className="text-body-strong text-ink-900">{u.name}</p>
                    <p className="text-caption text-ink-500">{u.email}</p>
                  </td>
                  <td className="px-4 py-3 hidden md:table-cell">
                    {u.email_verified ? (
                      <CheckCircle size={15} className="text-success-600" />
                    ) : (
                      <XCircle size={15} className="text-ink-400" />
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <select
                      value={u.role}
                      onChange={(e) => changeRole(u.id, e.target.value)}
                      className="bg-ink-100 border border-ink-200 rounded-md px-2 py-1 text-caption text-ink-700 focus:outline-none focus:border-brand-600 focus:ring-2 focus:ring-brand-600/20 transition-colors duration-(--duration-base)"
                    >
                      <option value="member">member</option>
                      <option value="admin">admin</option>
                    </select>
                  </td>
                  <td className="px-4 py-3 hidden lg:table-cell">
                    <span className="text-caption text-ink-500 tnum">
                      {new Date(u.created_at * 1000).toLocaleDateString()}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right">
                    {u.id !== me?.id && (
                      <div className="flex items-center justify-end gap-0.5">
                        <button
                          type="button"
                          onClick={() => openEdit(u)}
                          className="btn-ghost p-1.5 btn-sm text-ink-400 hover:text-ink-700"
                        >
                          <Pencil size={13} />
                        </button>
                        <button
                          type="button"
                          onClick={() => setDeleteTarget(u)}
                          className="btn-ghost p-1.5 text-danger-600 btn-sm"
                        >
                          <Trash2 size={13} />
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {total > limit && (
        <div className="flex items-center justify-between -mt-3">
          <span className="text-body text-ink-500 tnum">
            {page * limit + 1}–{Math.min((page + 1) * limit, total)} / {total}
          </span>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setPage((p) => p - 1)}
              disabled={page === 0}
              className="btn-secondary btn-sm"
            >
              {t('admin_users.prev')}
            </button>
            <button
              type="button"
              onClick={() => setPage((p) => p + 1)}
              disabled={(page + 1) * limit >= total}
              className="btn-secondary btn-sm"
            >
              {t('admin_users.next')}
            </button>
          </div>
        </div>
      )}

      {/* Delete confirmation modal */}
      {deleteTarget && (
        <div className="fixed inset-0 z-(--z-modal) flex items-center justify-center p-4 bg-ink-950/50 backdrop-blur-sm">
          <div className="card w-full max-w-sm p-6 shadow-lg">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-heading text-ink-900">{t('admin_users.confirm_delete')}</h2>
              <button type="button" onClick={() => setDeleteTarget(null)} className="btn-ghost p-1.5 rounded-lg">
                <X size={16} />
              </button>
            </div>
            <p className="text-body text-ink-500">
              {t('admin_users.confirm_delete_desc')}{' '}
              <span className="font-medium text-ink-900">{deleteTarget.name}</span> ({deleteTarget.email})?
            </p>
            <p className="text-body text-ink-500 mt-1">{t('admin_users.confirm_delete_warn')}</p>
            <div className="mt-6 flex gap-3">
              <button type="button" onClick={() => setDeleteTarget(null)} className="btn-secondary flex-1">
                {t('admin_users.cancel')}
              </button>
              <button
                type="button"
                onClick={() => deleteUser(deleteTarget.id)}
                disabled={deleteLoading}
                className="btn-danger flex-1"
              >
                {deleteLoading ? '…' : t('admin_users.confirm')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Add / Edit modal */}
      {modal && (
        <div className="fixed inset-0 z-(--z-modal) flex items-center justify-center p-4 bg-ink-950/50 backdrop-blur-sm">
          <div className="card w-full max-w-md p-6 shadow-lg">
            <div className="flex items-center justify-between mb-6">
              <h2 className="text-heading text-ink-900">
                {modal.mode === 'create' ? t('admin_users.new_user') : t('admin_users.edit_user')}
              </h2>
              <button type="button" onClick={closeModal} className="btn-ghost p-1.5 rounded-lg">
                <X size={16} />
              </button>
            </div>

            <div className="space-y-4">
              <div>
                <label htmlFor="user-name" className="label">
                  {t('admin_users.name')}
                </label>
                <input
                  id="user-name"
                  type="text"
                  value={form.name}
                  onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                  className="input"
                  required
                  // biome-ignore lint/a11y/noAutofocus: focus moves into the dialog that just opened
                  autoFocus
                />
              </div>
              <div>
                <label htmlFor="user-email" className="label">
                  {t('admin_users.email')}
                </label>
                <input
                  id="user-email"
                  type="email"
                  value={form.email}
                  onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
                  className="input"
                  required
                />
              </div>
              <div>
                <label htmlFor="user-password" className="label">
                  {t('admin_users.password')}
                </label>
                <input
                  id="user-password"
                  type="password"
                  value={form.password}
                  onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
                  className="input"
                  placeholder={modal.mode === 'edit' ? t('admin_users.password_hint') : ''}
                  required={modal.mode === 'create'}
                />
              </div>
              <div>
                <label htmlFor="user-role" className="label">
                  {t('admin_users.role')}
                </label>
                <select
                  id="user-role"
                  value={form.role}
                  onChange={(e) => setForm((f) => ({ ...f, role: e.target.value }))}
                  className="input"
                >
                  <option value="member">member</option>
                  <option value="admin">admin</option>
                </select>
              </div>
            </div>

            {formError && <p className="text-body text-danger-600 mt-3">{formError}</p>}

            <div className="mt-6 flex gap-3">
              <button type="button" onClick={closeModal} className="btn-secondary flex-1">
                {t('admin_users.cancel')}
              </button>
              <button type="button" onClick={submitModal} disabled={formLoading} className="btn-primary flex-1">
                {formLoading ? '…' : modal.mode === 'create' ? t('admin_users.create') : t('admin_users.save')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
