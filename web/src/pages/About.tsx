import { Link } from 'react-router-dom'
import { Database, ArrowLeft, Server, Zap } from 'lucide-react'
import { useLocale } from '../hooks/useLocale'

const FEATURE_KEYS = [
  'about.feature_1', 'about.feature_2', 'about.feature_3',
  'about.feature_4', 'about.feature_5', 'about.feature_6',
  'about.feature_7', 'about.feature_8', 'about.feature_9',
] as const

const STACK = [
  { icon: Server, label: 'Cloudflare Workers + D1 + KV' },
  { icon: Zap, label: 'Hono v4' },
  { icon: Database, label: 'React 19 + TypeScript + Tailwind CSS v4' },
]

export default function AboutPage() {
  const { t } = useLocale()

  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-zinc-950">
      {/* Header */}
      <header className="px-4 py-3 border-b border-zinc-200 dark:border-zinc-800 flex items-center gap-3">
        <div className="w-7 h-7 bg-blue-600 rounded-md flex items-center justify-center">
          <Database size={15} className="text-white" />
        </div>
        <span className="font-semibold text-zinc-900 dark:text-zinc-100">{t('app.name')}</span>
        <div className="flex-1" />
        <Link to="/query" className="btn-ghost btn-sm gap-1.5">
          <ArrowLeft size={14} /> {t('profile.back_to_query')}
        </Link>
      </header>

      <div className="max-w-2xl mx-auto p-4 sm:p-6 space-y-6">
        {/* Title block */}
        <div className="flex items-center gap-4">
          <div className="w-12 h-12 bg-blue-600 rounded-2xl flex items-center justify-center shrink-0">
            <Database size={22} className="text-white" />
          </div>
          <div>
            <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">Zeta</h1>
            <p className="text-sm text-zinc-400 dark:text-zinc-500">v1.0.0</p>
          </div>
        </div>

        {/* Description */}
        <div className="card p-5">
          <p className="text-sm text-zinc-600 dark:text-zinc-400 leading-relaxed">
            {t('about.description')}
          </p>
        </div>

        {/* Features */}
        <div className="card p-5">
          <h2 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300 mb-4">{t('about.features')}</h2>
          <ul className="space-y-2">
            {FEATURE_KEYS.map((key) => (
              <li key={key} className="flex items-start gap-2.5 text-sm text-zinc-600 dark:text-zinc-400">
                <span className="text-blue-500 mt-0.5 shrink-0">·</span>
                {t(key)}
              </li>
            ))}
          </ul>
        </div>

        {/* Tech stack */}
        <div className="card p-5">
          <h2 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300 mb-4">{t('about.tech_stack')}</h2>
          <div className="space-y-2.5">
            {STACK.map(({ icon: Icon, label }) => (
              <div key={label} className="flex items-center gap-2.5 text-sm text-zinc-600 dark:text-zinc-400">
                <Icon size={14} className="text-zinc-400 shrink-0" />
                {label}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
