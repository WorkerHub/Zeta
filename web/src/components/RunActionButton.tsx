import { Loader2, Play } from 'lucide-react'
import { useLocale } from '../hooks/useLocale'

interface Props {
  /** The button's own label: Run / Run Selection / Run All. */
  label: string
  /** A run is in flight on this notebook: the button reports it and offers to cancel it. */
  running: boolean
  /** The cancel signal is on its way: the label says so until the run's response lands. */
  cancelling: boolean
  /** Idle only — a target is selected and connected. A run in flight stays clickable regardless. */
  enabled: boolean
  /** The idle tooltip, for the case the run cannot start (no connection yet). */
  title?: string
  onClick: () => void
  /** The bar's own sizing and display classes (the desktop copy is hidden below sm). */
  className: string
  iconSize: number
}

// The query page's one execution button, shared by the editor toolbar and the mobile bar. It starts
// the run; while that run is in flight it is the cancel button — spinning, still clickable, and
// saying 取消执行 on hover (「正在取消…」 once the signal is on its way). The request itself is never
// aborted: it returns on its own, carrying `cancelled` (see pages/Query.tsx and lib/runs.ts).
export default function RunActionButton({
  label,
  running,
  cancelling,
  enabled,
  title,
  onClick,
  className,
  iconSize,
}: Props) {
  const { t } = useLocale()
  const Icon = running ? Loader2 : Play

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!running && !enabled}
      aria-busy={running || undefined}
      title={running ? t(cancelling ? 'query.cancelling' : 'query.cancel_run') : title}
      className={className}
    >
      <Icon size={iconSize} className={running ? 'animate-spin' : undefined} aria-hidden="true" />
      {running && cancelling ? t('query.cancelling') : label}
    </button>
  )
}
