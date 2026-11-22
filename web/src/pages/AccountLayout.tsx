import { useState } from 'react'
import { Link, Outlet, useLocation } from 'react-router-dom'
import { ArrowLeft, User as UserIcon, Shield } from 'lucide-react'
import { useLocale } from '../hooks/useLocale'
import Logo from '../components/Logo'

export interface AccountOutletContext {
  dirty: boolean
  setDirty: (dirty: boolean) => void
}

export default function AccountLayout() {
  const { t } = useLocale()
  const loc = useLocation()
  const [dirty, setDirty] = useState(false)

  const isProfile = loc.pathname === '/profile'
  const isSecurity = loc.pathname === '/security'

  function checkUnsaved(e: React.MouseEvent) {
    if (dirty && !window.confirm(t('common.unsaved_changes_warning'))) {
      e.preventDefault()
    }
  }

  return (
    <div className="min-h-screen bg-ink-50 flex flex-col">
      {/* Header */}
      <header className="px-6 py-3 border-b border-ink-200 flex items-center gap-2.5 bg-ink-0 shrink-0">
        <Logo size="sm" />
        <span className="text-body-strong text-ink-900">{t('app.name')}</span>
        <div className="flex-1" />
        <Link to="/query" onClick={checkUnsaved} className="btn-ghost btn-sm gap-1.5">
          <ArrowLeft size={14} /> {t('profile.back_to_query')}
        </Link>
      </header>

      {/* Account Navigation Tabs */}
      <div className="max-w-2xl w-full mx-auto px-6 pt-8 pb-4 shrink-0">
        <nav className="flex gap-6 border-b border-ink-200" aria-label="Account navigation">
          <Link
            to="/profile"
            onClick={(e) => {
              if (!isProfile) checkUnsaved(e)
            }}
            className={`flex items-center gap-2 pb-3 text-body font-medium transition-colors duration-(--duration-base) -mb-px ${
              isProfile
                ? 'border-b-2 border-brand-600 text-ink-950 dark:border-brand-400'
                : 'text-ink-500 hover:text-ink-800'
            }`}
          >
            <UserIcon size={16} />
            {t('profile.tab_profile')}
          </Link>
          <Link
            to="/security"
            onClick={(e) => {
              if (!isSecurity) checkUnsaved(e)
            }}
            className={`flex items-center gap-2 pb-3 text-body font-medium transition-colors duration-(--duration-base) -mb-px ${
              isSecurity
                ? 'border-b-2 border-brand-600 text-ink-950 dark:border-brand-400'
                : 'text-ink-500 hover:text-ink-800'
            }`}
          >
            <Shield size={16} />
            {t('profile.tab_security')}
          </Link>
        </nav>
      </div>

      {/* Subpage content */}
      <main className="flex-1">
        <Outlet context={{ dirty, setDirty } satisfies AccountOutletContext} />
      </main>
    </div>
  )
}
