import { useState, useRef, useEffect } from 'react'
import { Link, Routes, Route, useLocation, Navigate } from 'react-router-dom'
import { Database, Users, Settings, Shield, Globe, Monitor, Sun, Moon, User as UserIcon, Info, LogOut } from 'lucide-react'
import { useLocale } from '../../hooks/useLocale'
import { useTheme } from '../../hooks/useTheme'
import { useAuthContext } from '../../hooks/useAuth'
import AdminUsers from './Users'
import AdminDatabases from './Databases'
import AdminSettings from './AdminSettings'

const THEME_ICONS = { auto: Monitor, light: Sun, dark: Moon }

export default function AdminLayout() {
  const loc = useLocation()
  const { t, locale, changeLocale } = useLocale()
  const { theme, cycleTheme } = useTheme()
  const { user, logout } = useAuthContext()
  const ThemeIcon = THEME_ICONS[theme]

  const [showUserMenu, setShowUserMenu] = useState(false)
  const userMenuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (userMenuRef.current && !userMenuRef.current.contains(e.target as Node)) setShowUserMenu(false)
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

  const nav = [
    { to: '/admin/users', label: t('admin.users'), icon: Users },
    { to: '/admin/databases', label: t('admin.databases'), icon: Database },
    { to: '/admin/settings', label: t('admin.settings'), icon: Settings },
  ]

  const menuItemClass = 'flex items-center gap-2 px-4 py-2.5 text-sm text-zinc-600 hover:bg-zinc-50 hover:text-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800 dark:hover:text-zinc-100 transition-colors'

  return (
    <div className="flex h-screen bg-zinc-50 dark:bg-zinc-950">
      {/* Sidebar — desktop only */}
      <aside className="w-56 border-r border-zinc-200 dark:border-zinc-800 flex-col shrink-0 hidden sm:flex">
        <div className="px-4 py-4 border-b border-zinc-200 dark:border-zinc-800 flex items-center gap-2">
          <div className="w-7 h-7 bg-blue-600 rounded-md flex items-center justify-center">
            <Shield size={14} className="text-white" />
          </div>
          <span className="font-semibold text-zinc-900 dark:text-zinc-100 text-sm">{t('admin.title')}</span>
        </div>
        <nav className="flex-1 p-2">
          {nav.map(({ to, label, icon: Icon }) => (
            <Link
              key={to} to={to}
              className={`flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm mb-0.5 transition-colors ${loc.pathname.startsWith(to) ? 'bg-zinc-200 text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100' : 'text-zinc-500 hover:bg-zinc-100 hover:text-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800/50 dark:hover:text-zinc-200'}`}
            >
              <Icon size={15} />
              {label}
            </Link>
          ))}
        </nav>
      </aside>

      {/* Right column: header + content */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Header */}
        <header className="h-12 shrink-0 flex items-center gap-1 px-3 border-b border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950">
          {/* Mobile nav items */}
          <div className="sm:hidden flex items-center gap-1 flex-1 overflow-hidden">
            {nav.map(({ to, label, icon: Icon }) => (
              <Link key={to} to={to}
                className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors shrink-0 ${loc.pathname.startsWith(to) ? 'bg-zinc-200 text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100' : 'text-zinc-500'}`}>
                <Icon size={13} />{label}
              </Link>
            ))}
          </div>

          <div className="flex-1 hidden sm:block" />

          {/* Language toggle */}
          <button
            onClick={() => changeLocale(locale === 'en' ? 'zh' : 'en')}
            className="btn-ghost btn-sm p-2"
            title={t('lang.label')}
          >
            <Globe size={15} />
          </button>

          {/* Theme toggle */}
          <button
            onClick={cycleTheme}
            className="btn-ghost btn-sm p-2"
            title={`Theme: ${theme}`}
          >
            <ThemeIcon size={15} />
          </button>

          {/* User menu */}
          <div className="relative" ref={userMenuRef}>
            <button
              onClick={() => setShowUserMenu(!showUserMenu)}
              className="w-8 h-8 rounded-full bg-zinc-100 border border-zinc-200 flex items-center justify-center text-zinc-500 hover:text-zinc-800 hover:bg-zinc-200 dark:bg-zinc-800 dark:border-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200 dark:hover:bg-zinc-700 transition-colors text-xs font-semibold"
            >
              {user?.name?.[0]?.toUpperCase() ?? '?'}
            </button>
            {showUserMenu && (
              <div className="absolute right-0 top-full mt-1 w-48 bg-white border border-zinc-200 dark:bg-zinc-900 dark:border-zinc-700 rounded-xl shadow-xl z-20 overflow-hidden">
                <div className="px-4 py-3 border-b border-zinc-100 dark:border-zinc-800">
                  <p className="text-sm font-medium text-zinc-800 dark:text-zinc-200 truncate">{user?.name}</p>
                  <p className="text-xs text-zinc-500 truncate">{user?.email}</p>
                </div>
                <Link to="/profile" onClick={() => setShowUserMenu(false)} className={menuItemClass}>
                  <UserIcon size={14} /> {t('user.profile_security')}
                </Link>
                <Link to="/query" onClick={() => setShowUserMenu(false)} className={menuItemClass}>
                  <Database size={14} /> {t('user.query_panel')}
                </Link>
                <Link to="/about" onClick={() => setShowUserMenu(false)} className={menuItemClass}>
                  <Info size={14} /> {t('user.about')}
                </Link>
                <button onClick={logout}
                  className="w-full flex items-center gap-2 px-4 py-2.5 text-sm text-red-400 hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors border-t border-zinc-100 dark:border-zinc-800">
                  <LogOut size={14} /> {t('user.sign_out')}
                </button>
              </div>
            )}
          </div>
        </header>

        {/* Content */}
        <main className="flex-1 overflow-auto">
          <Routes>
            <Route path="users" element={<AdminUsers />} />
            <Route path="databases" element={<AdminDatabases />} />
            <Route path="settings" element={<AdminSettings />} />
            <Route path="*" element={<Navigate to="/admin/users" replace />} />
          </Routes>
        </main>
      </div>
    </div>
  )
}
