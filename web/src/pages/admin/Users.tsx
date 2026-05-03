import { useState, useEffect } from 'react'
import { Search, Trash2, CheckCircle, XCircle, X, Pencil, UserPlus } from 'lucide-react'
import { adminApi } from '../../lib/api'
import { useAuthContext } from '../../hooks/useAuth'
import { useLocale } from '../../hooks/useLocale'
import type { User } from '../../types'

type ModalState =
  | { mode: 'create' }
  | { mode: 'edit'; user: User }

const EMPTY_FORM = { name: '', email: '', password: '', role: 'member' }

export default function AdminUsers() {
  const { user: me } = useAuthContext()
  const { t } = useLocale()
  const [users, setUsers] = useState<User[]>([])
  const [total, setTotal] = useState(0)
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [deleteError, setDeleteError] = useState('')
  const [page, setPage] = useState(0)
  const limit = 20

  const [modal, setModal] = useState<ModalState | null>(null)
  const [form, setForm] = useState(EMPTY_FORM)
  const [formError, setFormError] = useState('')
  const [formLoading, setFormLoading] = useState(false)

  const [deleteTarget, setDeleteTarget] = useState<User | null>(null)
  const [deleteLoading, setDeleteLoading] = useState(false)

  async function load() {
    setLoading(true)
    try {
      const res = await adminApi.users({ search, limit, offset: page * limit })
      setUsers(res.results)
      setTotal(res.total)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [search, page])

  async function changeRole(id: string, role: string) {
    await adminApi.updateUser(id, { role })
    load()
  }

  async function deleteUser(id: string) {
    setDeleteLoading(true)
    setDeleteError('')
    try {
      await adminApi.deleteUser(id)
      setDeleteTarget(null)
      load()
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : 'Failed to delete user')
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
      setFormError(err instanceof Error ? err.message : 'An error occurred')
    } finally {
      setFormLoading(false)
    }
  }

  return (
    <div className="p-4 sm:p-6 max-w-5xl">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">{t('admin.users')}</h1>
        <div className="flex items-center gap-2">
          <span className="badge badge-zinc">{total} {t('admin_users.total')}</span>
          <button onClick={openCreate} className="btn-primary btn-sm flex items-center gap-1.5">
            <UserPlus size={13} />
            {t('admin_users.add_user')}
          </button>
        </div>
      </div>

      {deleteError && (
        <p className="mb-3 text-sm text-red-400">{deleteError}</p>
      )}

      {/* Search */}
      <div className="relative mb-4">
        <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500" />
        <input
          type="text" value={search} onChange={(e) => { setSearch(e.target.value); setPage(0) }}
          className="input pl-9" placeholder={t('admin_users.search')}
        />
      </div>

      <div className="card overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-zinc-200 dark:border-zinc-800 bg-zinc-100/50 dark:bg-zinc-800/30">
              <th className="text-left px-4 py-3 text-xs font-medium text-zinc-500">{t('admin_users.user')}</th>
              <th className="text-left px-4 py-3 text-xs font-medium text-zinc-500 hidden md:table-cell">{t('admin_users.verified')}</th>
              <th className="text-left px-4 py-3 text-xs font-medium text-zinc-500">{t('admin_users.role')}</th>
              <th className="text-left px-4 py-3 text-xs font-medium text-zinc-500 hidden lg:table-cell">{t('admin_users.joined')}</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={5} className="px-4 py-8 text-center text-zinc-500 text-sm">{t('admin_users.loading')}</td></tr>
            ) : users.length === 0 ? (
              <tr><td colSpan={5} className="px-4 py-8 text-center text-zinc-500 text-sm">{t('admin_users.no_users')}</td></tr>
            ) : users.map((u) => (
              <tr key={u.id} className="border-b border-zinc-100 hover:bg-zinc-50 dark:border-zinc-800/50 dark:hover:bg-zinc-800/20 transition-colors">
                <td className="px-4 py-3">
                  <p className="font-medium text-zinc-800 dark:text-zinc-200">{u.name}</p>
                  <p className="text-xs text-zinc-500">{u.email}</p>
                </td>
                <td className="px-4 py-3 hidden md:table-cell">
                  {u.email_verified ? (
                    <CheckCircle size={15} className="text-emerald-400" />
                  ) : (
                    <XCircle size={15} className="text-zinc-600" />
                  )}
                </td>
                <td className="px-4 py-3">
                  <select
                    value={u.role}
                    onChange={(e) => changeRole(u.id, e.target.value)}
                    className="bg-zinc-100 border border-zinc-200 rounded-md px-2 py-1 text-xs text-zinc-700 dark:bg-zinc-800 dark:border-zinc-700 dark:text-zinc-200 focus:outline-none focus:border-blue-500"
                  >
                    <option value="member">member</option>
                    <option value="admin">admin</option>
                  </select>
                </td>
                <td className="px-4 py-3 hidden lg:table-cell">
                  <span className="text-xs text-zinc-500">
                    {new Date(u.created_at * 1000).toLocaleDateString()}
                  </span>
                </td>
                <td className="px-4 py-3 text-right">
                  {u.id !== me?.id && (
                    <div className="flex items-center justify-end gap-0.5">
                      <button onClick={() => openEdit(u)} className="btn-ghost p-1.5 btn-sm text-zinc-400">
                        <Pencil size={13} />
                      </button>
                      <button onClick={() => setDeleteTarget(u)} className="btn-ghost p-1.5 text-red-400 btn-sm">
                        <Trash2 size={13} />
                      </button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {total > limit && (
        <div className="flex items-center justify-between mt-4">
          <span className="text-sm text-zinc-500">
            {page * limit + 1}–{Math.min((page + 1) * limit, total)} / {total}
          </span>
          <div className="flex gap-2">
            <button onClick={() => setPage(p => p - 1)} disabled={page === 0} className="btn-secondary btn-sm">{t('admin_users.prev')}</button>
            <button onClick={() => setPage(p => p + 1)} disabled={(page + 1) * limit >= total} className="btn-secondary btn-sm">{t('admin_users.next')}</button>
          </div>
        </div>
      )}

      {/* Delete confirmation modal */}
      {deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
          <div className="card w-full max-w-sm p-6 shadow-2xl">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">{t('admin_users.confirm_delete')}</h2>
              <button onClick={() => setDeleteTarget(null)} className="btn-ghost p-1.5 rounded-lg"><X size={16} /></button>
            </div>
            <p className="text-sm text-zinc-500 dark:text-zinc-400">
              {t('admin_users.confirm_delete_desc')}{' '}
              <span className="font-medium text-zinc-800 dark:text-zinc-200">{deleteTarget.name}</span>
              {' '}({deleteTarget.email})?
            </p>
            <p className="text-sm text-zinc-500 dark:text-zinc-400 mt-1">{t('admin_users.confirm_delete_warn')}</p>
            <div className="mt-6 flex gap-3">
              <button onClick={() => setDeleteTarget(null)} className="btn-secondary flex-1">{t('admin_users.cancel')}</button>
              <button onClick={() => deleteUser(deleteTarget.id)} disabled={deleteLoading} className="btn-danger flex-1">
                {deleteLoading ? '…' : t('admin_users.confirm')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Add / Edit modal */}
      {modal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
          <div className="card w-full max-w-md p-6 shadow-2xl">
            <div className="flex items-center justify-between mb-6">
              <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">
                {modal.mode === 'create' ? t('admin_users.new_user') : t('admin_users.edit_user')}
              </h2>
              <button onClick={closeModal} className="btn-ghost p-1.5 rounded-lg"><X size={16} /></button>
            </div>

            <div className="space-y-4">
              <div>
                <label className="label">{t('admin_users.name')}</label>
                <input
                  type="text" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                  className="input" required autoFocus
                />
              </div>
              <div>
                <label className="label">{t('admin_users.email')}</label>
                <input
                  type="email" value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))}
                  className="input" required
                />
              </div>
              <div>
                <label className="label">{t('admin_users.password')}</label>
                <input
                  type="password" value={form.password} onChange={e => setForm(f => ({ ...f, password: e.target.value }))}
                  className="input" placeholder={modal.mode === 'edit' ? t('admin_users.password_hint') : ''}
                  required={modal.mode === 'create'}
                />
              </div>
              <div>
                <label className="label">{t('admin_users.role')}</label>
                <select
                  value={form.role} onChange={e => setForm(f => ({ ...f, role: e.target.value }))}
                  className="input"
                >
                  <option value="member">member</option>
                  <option value="admin">admin</option>
                </select>
              </div>
            </div>

            {formError && <p className="text-sm text-red-400 mt-3">{formError}</p>}

            <div className="mt-6 flex gap-3">
              <button onClick={closeModal} className="btn-secondary flex-1">{t('admin_users.cancel')}</button>
              <button onClick={submitModal} disabled={formLoading} className="btn-primary flex-1">
                {formLoading ? '…' : modal.mode === 'create' ? t('admin_users.create') : t('admin_users.save')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
