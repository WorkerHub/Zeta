import { Check, Loader2, PlugZap, Unplug } from 'lucide-react'
import { useLocale } from '../hooks/useLocale'

interface Props {
  /** The current target has answered a probe in this browser session. */
  connected: boolean
  /** A probe for the current target is in flight. */
  busy: boolean
  onConnect: () => void
  onDisconnect: () => void
}

/**
 * The one connect control of the query page, sitting beside the target switcher.
 *
 * Not connected reads as the page's only action (brand); connected reads as a state (neutral) and
 * turns into "disconnect" on hover, so the button never hides what the click will do. Nothing about
 * the mechanism is explained here — the state and the label carry it.
 */
export default function ConnectButton({ connected, busy, onConnect, onDisconnect }: Props) {
  const { t } = useLocale()

  if (busy) {
    return (
      <button type="button" disabled aria-busy="true" className="btn-secondary btn-sm gap-1.5 shrink-0">
        <Loader2 size={13} className="animate-spin" aria-hidden="true" />
        {t('query.connect')}
      </button>
    )
  }

  if (!connected) {
    return (
      <button
        type="button"
        onClick={onConnect}
        aria-pressed={false}
        title={t('query.connect')}
        className="btn-primary btn-sm gap-1.5 shrink-0"
      >
        <PlugZap size={13} aria-hidden="true" />
        {t('query.connect')}
      </button>
    )
  }

  return (
    <button
      type="button"
      onClick={onDisconnect}
      aria-pressed={true}
      aria-label={t('query.disconnect')}
      title={t('query.disconnect')}
      className="btn-secondary btn-sm gap-1.5 shrink-0 group"
    >
      <Check size={13} aria-hidden="true" className="group-hover:hidden group-focus-visible:hidden" />
      <Unplug size={13} aria-hidden="true" className="hidden group-hover:block group-focus-visible:block" />
      <span className="group-hover:hidden group-focus-visible:hidden">{t('query.connected')}</span>
      <span className="hidden group-hover:inline group-focus-visible:inline">{t('query.disconnect')}</span>
    </button>
  )
}
