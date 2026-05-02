import { X, Database, Server, Zap } from 'lucide-react'
import { useLocale } from '../hooks/useLocale'

interface Props {
  onClose: () => void
}

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

export default function AboutModal({ onClose }: Props) {
  const { t } = useLocale()

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-white dark:bg-zinc-900 rounded-2xl shadow-2xl border border-zinc-200 dark:border-zinc-800 w-full max-w-md max-h-[85vh] flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-100 dark:border-zinc-800 shrink-0">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 bg-blue-600 rounded-xl flex items-center justify-center shrink-0">
              <Database size={18} className="text-white" />
            </div>
            <div>
              <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">Zeta</h2>
              <p className="text-xs text-zinc-400 dark:text-zinc-500">v1.0.0</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-zinc-400 hover:text-zinc-700 hover:bg-zinc-100 dark:hover:text-zinc-200 dark:hover:bg-zinc-800 transition-colors"
          >
            <X size={16} />
          </button>
        </div>

        <div className="overflow-y-auto flex-1 px-6 py-5 space-y-5">
          {/* Description */}
          <p className="text-sm text-zinc-600 dark:text-zinc-400 leading-relaxed">
            {t('about.description')}
          </p>

          {/* Features */}
          <div>
            <h3 className="text-xs font-semibold text-zinc-500 dark:text-zinc-400 uppercase tracking-wider mb-2.5">{t('about.features')}</h3>
            <ul className="space-y-1.5">
              {FEATURE_KEYS.map((key) => (
                <li key={key} className="flex items-start gap-2 text-xs text-zinc-600 dark:text-zinc-400">
                  <span className="text-blue-500 mt-px shrink-0">·</span>
                  {t(key)}
                </li>
              ))}
            </ul>
          </div>

          {/* Stack */}
          <div>
            <h3 className="text-xs font-semibold text-zinc-500 dark:text-zinc-400 uppercase tracking-wider mb-2.5">{t('about.tech_stack')}</h3>
            <div className="space-y-1.5">
              {STACK.map(({ icon: Icon, label }) => (
                <div key={label} className="flex items-center gap-2 text-xs text-zinc-600 dark:text-zinc-400">
                  <Icon size={12} className="text-zinc-400 shrink-0" />
                  {label}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
