import { useEffect, useState } from 'react'
import { Layers, Terminal } from 'lucide-react'
import { useLocale } from '../hooks/useLocale'
import type { Database } from '../types'
import Dialog from './Dialog'
import LivyConsolePanel from './LivyConsolePanel'
import LivyBatchesPanel from './LivyBatchesPanel'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  database: Database | null
  userId: string
  defaultTab?: 'console' | 'batches'
}

export default function LivyDialog({ open, onOpenChange, database, userId, defaultTab = 'console' }: Props) {
  const { t } = useLocale()
  const [activeTab, setActiveTab] = useState<'console' | 'batches'>(defaultTab)

  useEffect(() => {
    if (open) {
      setActiveTab(defaultTab)
    }
  }, [open, defaultTab])

  if (!database) return null

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={
        <div className="flex items-center gap-3">
          <span className="font-semibold text-ink-950">
            {t('livy.dialog_title')}
            <span className="ml-2 text-caption text-ink-500 font-normal">({database.name})</span>
          </span>
          <div className="flex items-center gap-1 rounded-md border border-ink-200 bg-ink-100 p-0.5 text-caption font-normal ml-2">
            <button
              type="button"
              onClick={() => setActiveTab('console')}
              className={`flex items-center gap-1.5 px-3 py-1 rounded transition-colors duration-(--duration-base) ${
                activeTab === 'console'
                  ? 'bg-ink-0 text-ink-900 font-medium shadow-xs'
                  : 'text-ink-500 hover:text-ink-800'
              }`}
            >
              <Terminal size={13} />
              <span>{t('livy.tab_console')}</span>
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('batches')}
              className={`flex items-center gap-1.5 px-3 py-1 rounded transition-colors duration-(--duration-base) ${
                activeTab === 'batches'
                  ? 'bg-ink-0 text-ink-900 font-medium shadow-xs'
                  : 'text-ink-500 hover:text-ink-800'
              }`}
            >
              <Layers size={13} />
              <span>{t('livy.tab_batches')}</span>
            </button>
          </div>
        </div>
      }
      className="max-w-4xl"
    >
      {activeTab === 'console' ? (
        <LivyConsolePanel databaseId={database.id} userId={userId} />
      ) : (
        <LivyBatchesPanel databaseId={database.id} />
      )}
    </Dialog>
  )
}
