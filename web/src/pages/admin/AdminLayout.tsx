import { useState, useRef, useEffect } from 'react'
import { Link, Routes, Route, useLocation, Navigate } from 'react-router-dom'
import { ArrowLeft, Database, Users, Settings, Globe, Monitor, Sun, Moon, User as UserIcon, Info, LogOut } from 'lucide-react'
import { useLocale } from '../../hooks/useLocale'
import { useTheme } from '../../hooks/useTheme'
import { useAuthContext } from '../../hooks/useAuth'
import Logo from '../../components/Logo'
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

  const menuItemClass =
    'flex items-center gap-2 px-4 py-2.5 text-body text-ink-700 hover:bg-ink-100 hover:text-ink-950 transition-colors duration-(--duration-base)'

  return (
    <div className="flex h-screen bg-ink-50">
      {/* Sidebar — desktop only */}
      <aside className="w-56 border-r border-ink-200 flex-col shrink-0 hidden sm:flex bg-ink-0">
        <div className="h-12 px-4 border-b border-ink-200 flex items-center gap-2.5">
          <Logo size="sm" />
          <span className="text-body-strong text-ink-900">{t('admin.title')}</span>
        </div>
        <nav className="flex-1 p-2">
          {nav.map(({ to, label, icon: Icon }) => (
            <Link
              key={to}
              to={to}
              className={`flex items-center gap-2.5 px-3 py-2 rounded-lg text-body mb-0.5 transition-colors duration-(--duration-base) ${loc.pathname.startsWith(to) ? 'bg-brand-50 text-brand-700 dark:text-brand-300 font-medium' : 'text-ink-500 hover:bg-ink-100 hover:text-ink-900'}`}
            >
              <Icon size={15} />
              {label}
            </Link>
          ))}
        </nav>
        <div className="border-t border-ink-200 p-2">
          <Link
            to="/query"
            className="flex items-center gap-2.5 px-3 py-2 rounded-lg text-body transition-colors duration-(--duration-base) text-ink-500 hover:bg-ink-100 hover:text-ink-900"
          >
            <ArrowLeft size={15} />
            {t('admin.back_to_query')}
          </Link>
        </div>
      </aside>

      {/* Right column: header + content */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Header */}
        <header className="h-12 shrink-0 flex items-center gap-1 px-3 border-b border-ink-200 bg-ink-0">
          {/* Mobile nav items */}
          <div className="sm:hidden flex items-center gap-1 flex-1 overflow-hidden">
            {nav.map(({ to, label, icon: Icon }) => (
              <Link
                key={to}
                to={to}
                className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-caption font-medium transition-colors duration-(--duration-base) shrink-0 ${loc.pathname.startsWith(to) ? 'bg-brand-50 text-brand-700 dark:text-brand-300' : 'text-ink-500'}`}
              >
                <Icon size={13} />
                {label}
              </Link>
            ))}
          </div>

          <div className="flex-1 hidden sm:block" />

          {/* Language toggle */}
          <button
            type="button"
            onClick={() => changeLocale(locale === 'en' ? 'zh' : 'en')}
            className="btn-ghost btn-sm p-2"
            title={t('lang.label')}
          >
            <Globe size={15} />
          </button>

          {/* Theme toggle */}
          <button
            type="button"
            onClick={cycleTheme}
            className="btn-ghost btn-sm p-2"
            title={`${t('theme.label')}: ${t(`theme.${theme}`)}`}
          >
            <ThemeIcon size={15} />
          </button>

          {/* User menu */}
          <div className="relative" ref={userMenuRef}>
            <button
              type="button"
              onClick={() => setShowUserMenu(!showUserMenu)}
              className="w-8 h-8 rounded-full bg-ink-100 border border-ink-200 flex items-center justify-center text-ink-500 hover:text-ink-900 hover:bg-ink-200 transition-colors duration-(--duration-base) text-caption font-semibold"
            >
              {user?.name?.[0]?.toUpperCase() ?? '?'}
            </button>
            {showUserMenu && (
              <div className="absolute right-0 top-full mt-1 w-48 bg-ink-0 border border-ink-200 rounded-lg shadow-md z-(--z-dropdown) overflow-hidden animate-overlay-enter">
                <div className="px-4 py-3 border-b border-ink-200">
                  <p className="text-body-strong text-ink-900 truncate">{user?.name}</p>
                  <p className="text-caption text-ink-500 truncate">{user?.email}</p>
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
                <button
                  type="button"
                  onClick={logout}
                  className="w-full flex items-center gap-2 px-4 py-2.5 text-body text-danger-600 hover:bg-ink-100 transition-colors duration-(--duration-base) border-t border-ink-200"
                >
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
