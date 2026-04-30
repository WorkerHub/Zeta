import { useState, useEffect } from 'react'
import { Plus, Trash2, Power, Users } from 'lucide-react'
import { adminApi } from '../../lib/api'

interface DbRecord {
  id: string
  name: string
  description: string | null
  binding_name: string
  is_active: number
  created_at: number
}

interface Permission {
  id: string
  user_id: string
  database_id: string
  permission: string
  email: string
  user_name: string
}

export default function AdminDatabases() {
  const [databases, setDatabases] = useState<DbRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [showAdd, setShowAdd] = useState(false)
  const [newDb, setNewDb] = useState({ name: '', description: '', binding_name: '' })
  const [addError, setAddError] = useState('')
  const [selectedDb, setSelectedDb] = useState<DbRecord | null>(null)
  const [permissions, setPermissions] = useState<Permission[]>([])
  const [allUsers, setAllUsers] = useState<Array<{ id: string; email: string; name: string }>>([])
  const [permUserId, setPermUserId] = useState('')
  const [permLevel, setPermLevel] = useState('read')

  async function load() {
    setLoading(true)
    try {
      const res = await adminApi.databases()
      setDatabases(res.results as DbRecord[])
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  async function addDatabase() {
    setAddError('')
    try {
      await adminApi.createDatabase(newDb)
      setShowAdd(false)
      setNewDb({ name: '', description: '', binding_name: '' })
      load()
    } catch (err) {
      setAddError(err instanceof Error ? err.message : 'Failed')
    }
  }

  async function toggleActive(db: DbRecord) {
    await adminApi.updateDatabase(db.id, { is_active: !db.is_active })
    load()
  }

  async function deleteDb(id: string, name: string) {
    if (!confirm(`Delete database "${name}" from registry? This does not delete the actual D1 database.`)) return
    await adminApi.deleteDatabase(id)
    load()
  }

  async function loadPermissions(db: DbRecord) {
    setSelectedDb(db)
    const [perms, users] = await Promise.all([
      adminApi.getPermissions(db.id),
      adminApi.users({ limit: 200 }),
    ])
    setPermissions(perms.results as Permission[])
    setAllUsers(users.results.map((u) => ({ id: u.id, email: u.email, name: u.name })))
  }

  async function grantPerm() {
    if (!selectedDb || !permUserId) return
    await adminApi.setPermission(selectedDb.id, permUserId, permLevel)
    await loadPermissions(selectedDb)
    setPermUserId('')
  }

  async function revokePerm(userId: string) {
    if (!selectedDb) return
    await adminApi.revokePermission(selectedDb.id, userId)
    await loadPermissions(selectedDb)
  }

  return (
    <div className="p-4 sm:p-6 max-w-5xl">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">Databases</h1>
        <button onClick={() => setShowAdd(!showAdd)} className="btn-primary btn-sm gap-1.5">
          <Plus size={13} /> Add database
        </button>
      </div>

      {/* Add form */}
      {showAdd && (
        <div className="card p-5 mb-4 space-y-4">
          <h2 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300">Register a D1 database</h2>
          <p className="text-xs text-zinc-500">The binding must already exist in your Worker's wrangler.toml.</p>
          <div className="grid sm:grid-cols-2 gap-4">
            <div>
              <label className="label">Display name</label>
              <input type="text" className="input" value={newDb.name}
                onChange={(e) => setNewDb({ ...newDb, name: e.target.value })} placeholder="My Database" />
            </div>
            <div>
              <label className="label">Binding name</label>
              <input type="text" className="input font-mono" value={newDb.binding_name}
                onChange={(e) => setNewDb({ ...newDb, binding_name: e.target.value.toUpperCase() })}
                placeholder="QUERY_DB_1" />
            </div>
            <div className="sm:col-span-2">
              <label className="label">Description (optional)</label>
              <input type="text" className="input" value={newDb.description}
                onChange={(e) => setNewDb({ ...newDb, description: e.target.value })} placeholder="What's in this database?" />
            </div>
          </div>
          {addError && <p className="text-sm text-red-400">{addError}</p>}
          <div className="flex gap-3">
            <button onClick={() => setShowAdd(false)} className="btn-secondary">Cancel</button>
            <button onClick={addDatabase} className="btn-primary" disabled={!newDb.name || !newDb.binding_name}>
              Register
            </button>
          </div>
        </div>
      )}

      {/* Database list */}
      <div className="card overflow-hidden mb-6">
        {loading ? (
          <p className="px-4 py-8 text-center text-sm text-zinc-500">Loading…</p>
        ) : databases.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-zinc-500">No databases registered yet</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-200 dark:border-zinc-800 bg-zinc-100/50 dark:bg-zinc-800/30">
                <th className="text-left px-4 py-3 text-xs font-medium text-zinc-500">Name</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-zinc-500 hidden md:table-cell">Binding</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-zinc-500">Status</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {databases.map((db) => (
                <tr key={db.id} className="border-b border-zinc-100 hover:bg-zinc-50 dark:border-zinc-800/50 dark:hover:bg-zinc-800/20 transition-colors">
                  <td className="px-4 py-3">
                    <p className="font-medium text-zinc-800 dark:text-zinc-200">{db.name}</p>
                    {db.description && <p className="text-xs text-zinc-500">{db.description}</p>}
                  </td>
                  <td className="px-4 py-3 hidden md:table-cell">
                    <code className="text-xs text-amber-400 font-mono bg-amber-400/10 px-1.5 py-0.5 rounded">
                      {db.binding_name}
                    </code>
                  </td>
                  <td className="px-4 py-3">
                    <span className={`badge ${db.is_active ? 'badge-green' : 'badge-zinc'}`}>
                      {db.is_active ? 'Active' : 'Inactive'}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-1 justify-end">
                      <button onClick={() => loadPermissions(db)} className="btn-ghost btn-sm gap-1">
                        <Users size={13} /> Permissions
                      </button>
                      <button onClick={() => toggleActive(db)} className="btn-ghost btn-sm p-1.5" title="Toggle active">
                        <Power size={13} className={db.is_active ? 'text-emerald-400' : 'text-zinc-600'} />
                      </button>
                      <button onClick={() => deleteDb(db.id, db.name)} className="btn-ghost btn-sm p-1.5 text-red-400">
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
          <h2 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300 mb-4">
            Permissions for <span className="text-zinc-900 dark:text-zinc-100">{selectedDb.name}</span>
          </h2>
          <p className="text-xs text-zinc-500 mb-4">Admins always have full write access. These permissions apply to members only.</p>

          {/* Grant form */}
          <div className="flex gap-2 mb-4 flex-wrap">
            <select value={permUserId} onChange={(e) => setPermUserId(e.target.value)}
              className="input flex-1 min-w-[180px]">
              <option value="">Select user…</option>
              {allUsers.filter((u) => !permissions.some((p) => p.user_id === u.id)).map((u) => (
                <option key={u.id} value={u.id}>{u.name} ({u.email})</option>
              ))}
            </select>
            <select value={permLevel} onChange={(e) => setPermLevel(e.target.value)}
              className="input w-28">
              <option value="read">read</option>
              <option value="write">write</option>
            </select>
            <button onClick={grantPerm} disabled={!permUserId} className="btn-primary btn-sm">Grant</button>
          </div>

          {/* Current permissions */}
          {permissions.length === 0 ? (
            <p className="text-sm text-zinc-500">No member permissions set. Only admins can access this database.</p>
          ) : (
            <ul className="space-y-2">
              {permissions.map((p) => (
                <li key={p.id} className="flex items-center justify-between bg-zinc-100 dark:bg-zinc-800 rounded-lg px-4 py-2.5">
                  <div>
                    <p className="text-sm text-zinc-800 dark:text-zinc-200">{p.user_name}</p>
                    <p className="text-xs text-zinc-500">{p.email}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className={`badge ${p.permission === 'write' ? 'badge-blue' : 'badge-zinc'}`}>{p.permission}</span>
                    <button onClick={() => revokePerm(p.user_id)} className="btn-ghost p-1.5 text-red-400 btn-sm">
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
