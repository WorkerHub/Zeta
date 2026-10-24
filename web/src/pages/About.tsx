import { Link } from 'react-router-dom'
import { ArrowLeft, Server, Zap, Database } from 'lucide-react'
import { useLocale } from '../hooks/useLocale'
import Logo from '../components/Logo'

const FEATURE_KEYS = [
  'about.feature_1',
  'about.feature_2',
  'about.feature_3',
  'about.feature_4',
  'about.feature_5',
  'about.feature_6',
  'about.feature_7',
  'about.feature_8',
  'about.feature_9',
] as const

const STACK = [
  { icon: Server, label: 'Cloudflare Workers + D1 + KV' },
  { icon: Zap, label: 'Hono v4' },
  { icon: Database, label: 'React 19 + TypeScript + Tailwind CSS v4' },
]

export default function AboutPage() {
  const { t } = useLocale()

  return (
    <div className="min-h-screen bg-ink-50">
      {/* Header */}
      <header className="px-6 py-3 border-b border-ink-200 flex items-center gap-2.5 bg-ink-0">
        <Logo size="sm" />
        <span className="text-body-strong text-ink-900">{t('app.name')}</span>
        <div className="flex-1" />
        <Link to="/query" className="btn-ghost btn-sm gap-1.5">
          <ArrowLeft size={14} /> {t('profile.back_to_query')}
        </Link>
      </header>

      <div className="max-w-2xl mx-auto px-6 py-8 flex flex-col gap-8">
        {/* Title block */}
        <div className="flex items-center gap-4">
          <Logo size="lg" />
          <div>
            <h1 className="text-display text-ink-950">Zeta</h1>
            <p className="text-caption text-ink-500 tnum">{__APP_VERSION__}</p>
          </div>
        </div>

        {/* Description — the "Data Workbench" statement (design-system.md §1) */}
        <div className="card p-5">
          <p className="text-body text-ink-700 leading-relaxed">{t('about.description')}</p>
        </div>

        {/* Features */}
        <div className="card p-5">
          <h2 className="text-heading text-ink-900 mb-4">{t('about.features')}</h2>
          <ul className="flex flex-col gap-2">
            {FEATURE_KEYS.map((key) => (
              <li key={key} className="flex items-start gap-2.5 text-body text-ink-700">
                <span className="text-brand-500 mt-0.5 shrink-0">·</span>
                {t(key)}
              </li>
            ))}
          </ul>
        </div>

        {/* Tech stack */}
        <div className="card p-5">
          <h2 className="text-heading text-ink-900 mb-4">{t('about.tech_stack')}</h2>
          <div className="flex flex-col gap-2.5">
            {STACK.map(({ icon: Icon, label }) => (
              <div key={label} className="flex items-center gap-2.5 text-body text-ink-700">
                <Icon size={14} className="text-ink-400 shrink-0" />
                {label}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
