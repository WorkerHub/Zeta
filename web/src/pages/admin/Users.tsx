import { useState, useEffect } from 'react'
import { Search, Trash2, ChevronDown, CheckCircle, XCircle } from 'lucide-react'
import { adminApi } from '../../lib/api'
import type { User } from '../../types'

export default function AdminUsers() {
  const [users, setUsers] = useState<User[]>([])
  const [total, setTotal] = useState(0)
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [page, setPage] = useState(0)
  const limit = 20

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

  async function deleteUser(id: string, email: string) {
    if (!confirm(`Delete user ${email}?`)) return
    await adminApi.deleteUser(id)
    load()
  }

  return (
    <div className="p-4 sm:p-6 max-w-5xl">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-lg font-semibold text-zinc-100">Users</h1>
        <span className="badge badge-zinc">{total} total</span>
      </div>

      {/* Search */}
      <div className="relative mb-4">
        <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500" />
        <input
          type="text" value={search} onChange={(e) => { setSearch(e.target.value); setPage(0) }}
          className="input pl-9" placeholder="Search by name or email…"
        />
      </div>

      <div className="card overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-zinc-800 bg-zinc-800/30">
              <th className="text-left px-4 py-3 text-xs font-medium text-zinc-500">User</th>
              <th className="text-left px-4 py-3 text-xs font-medium text-zinc-500 hidden md:table-cell">Verified</th>
              <th className="text-left px-4 py-3 text-xs font-medium text-zinc-500">Role</th>
              <th className="text-left px-4 py-3 text-xs font-medium text-zinc-500 hidden lg:table-cell">Joined</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={5} className="px-4 py-8 text-center text-zinc-500 text-sm">Loading…</td></tr>
            ) : users.length === 0 ? (
              <tr><td colSpan={5} className="px-4 py-8 text-center text-zinc-500 text-sm">No users found</td></tr>
            ) : users.map((u) => (
              <tr key={u.id} className="border-b border-zinc-800/50 hover:bg-zinc-800/20 transition-colors">
                <td className="px-4 py-3">
                  <p className="font-medium text-zinc-200">{u.name}</p>
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
                    className="bg-zinc-800 border border-zinc-700 rounded-md px-2 py-1 text-xs text-zinc-200 focus:outline-none focus:border-blue-500"
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
                  <button onClick={() => deleteUser(u.id, u.email)} className="btn-ghost p-1.5 text-red-400 btn-sm">
                    <Trash2 size={13} />
                  </button>
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
            {page * limit + 1}–{Math.min((page + 1) * limit, total)} of {total}
          </span>
          <div className="flex gap-2">
            <button onClick={() => setPage(p => p - 1)} disabled={page === 0} className="btn-secondary btn-sm">Prev</button>
            <button onClick={() => setPage(p => p + 1)} disabled={(page + 1) * limit >= total} className="btn-secondary btn-sm">Next</button>
          </div>
        </div>
      )}
    </div>
  )
}
