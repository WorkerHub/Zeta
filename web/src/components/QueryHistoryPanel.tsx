import { useEffect, useState } from 'react'
import { History, XCircle, CheckCircle2, Clock } from 'lucide-react'
import { queryApi } from '../lib/api'

interface HistoryItem {
  id: string
  sql: string
  duration_ms: number | null
  row_count: number | null
  error: string | null
  executed_at: number
}

interface Props {
  databaseId: string
  onSelect: (sql: string) => void
}

export default function QueryHistoryPanel({ databaseId, onSelect }: Props) {
  const [items, setItems] = useState<HistoryItem[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    queryApi.history({ databaseId, limit: 50 })
      .then((res) => setItems(res.results as HistoryItem[]))
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [databaseId])

  const timeAgo = (ts: number) => {
    const diff = Math.floor(Date.now() / 1000) - ts
    if (diff < 60) return 'just now'
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
    return `${Math.floor(diff / 86400)}d ago`
  }

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-zinc-800">
        <History size={14} className="text-zinc-500" />
        <span className="text-xs font-medium text-zinc-500 uppercase tracking-wider">Query History</span>
      </div>
      {loading ? (
        <div className="flex items-center justify-center flex-1 text-zinc-600 text-sm">Loading…</div>
      ) : items.length === 0 ? (
        <div className="flex items-center justify-center flex-1 text-zinc-600 text-sm">No history yet</div>
      ) : (
        <div className="flex-1 overflow-auto">
          {items.map((item) => (
            <button
              key={item.id}
              onClick={() => onSelect(item.sql)}
              className="w-full text-left px-4 py-3 border-b border-zinc-800/50 hover:bg-zinc-800/30 transition-colors group"
            >
              <div className="flex items-center gap-1.5 mb-1">
                {item.error
                  ? <XCircle size={11} className="text-red-400 shrink-0" />
                  : <CheckCircle2 size={11} className="text-emerald-400 shrink-0" />}
                <span className="text-xs text-zinc-500">{timeAgo(item.executed_at)}</span>
                {item.duration_ms !== null && (
                  <>
                    <span className="text-zinc-700">·</span>
                    <Clock size={10} className="text-zinc-600" />
                    <span className="text-xs text-zinc-600">{item.duration_ms}ms</span>
                  </>
                )}
                {item.row_count !== null && !item.error && (
                  <>
                    <span className="text-zinc-700">·</span>
                    <span className="text-xs text-zinc-600">{item.row_count} rows</span>
                  </>
                )}
              </div>
              <pre className="text-xs text-zinc-400 font-mono truncate group-hover:text-zinc-200 transition-colors">
                {item.sql}
              </pre>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
