import { Link, Routes, Route, useLocation, Navigate } from 'react-router-dom'
import { Database, Users, Settings, ArrowLeft, Shield } from 'lucide-react'
import AdminUsers from './Users'
import AdminDatabases from './Databases'
import AdminSettings from './AdminSettings'

const nav = [
  { to: '/admin/users', label: 'Users', icon: Users },
  { to: '/admin/databases', label: 'Databases', icon: Database },
  { to: '/admin/settings', label: 'Settings', icon: Settings },
]

export default function AdminLayout() {
  const loc = useLocation()

  return (
    <div className="flex h-screen bg-zinc-950">
      {/* Sidebar */}
      <aside className="w-56 border-r border-zinc-800 flex flex-col shrink-0 hidden sm:flex">
        <div className="px-4 py-4 border-b border-zinc-800 flex items-center gap-2">
          <div className="w-7 h-7 bg-blue-600 rounded-md flex items-center justify-center">
            <Shield size={14} className="text-white" />
          </div>
          <span className="font-semibold text-zinc-100 text-sm">Admin Panel</span>
        </div>
        <nav className="flex-1 p-2">
          {nav.map(({ to, label, icon: Icon }) => (
            <Link
              key={to} to={to}
              className={`flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm mb-0.5 transition-colors ${loc.pathname.startsWith(to) ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-400 hover:bg-zinc-800/50 hover:text-zinc-200'}`}
            >
              <Icon size={15} />
              {label}
            </Link>
          ))}
        </nav>
        <div className="p-2 border-t border-zinc-800">
          <Link to="/query" className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800 transition-colors">
            <ArrowLeft size={14} /> Back to query
          </Link>
        </div>
      </aside>

      {/* Mobile top nav */}
      <div className="sm:hidden fixed top-0 left-0 right-0 z-10 bg-zinc-950 border-b border-zinc-800 flex items-center gap-1 px-2 py-2">
        {nav.map(({ to, label, icon: Icon }) => (
          <Link key={to} to={to}
            className={`flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg text-xs font-medium transition-colors ${loc.pathname.startsWith(to) ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-500'}`}>
            <Icon size={13} />{label}
          </Link>
        ))}
      </div>

      {/* Content */}
      <main className="flex-1 overflow-auto sm:pt-0 pt-14">
        <Routes>
          <Route path="users" element={<AdminUsers />} />
          <Route path="databases" element={<AdminDatabases />} />
          <Route path="settings" element={<AdminSettings />} />
          <Route path="*" element={<Navigate to="/admin/users" replace />} />
        </Routes>
      </main>
    </div>
  )
}
