import { Check, Loader2, PlugZap, Unplug } from 'lucide-react'
import { useLocale } from '../hooks/useLocale'

interface Props {
  /** The current target has answered a probe in this browser session. */
  connected: boolean
  /** A probe for the current target is in flight. */
  busy: boolean
  /** Connected but the selected profile moved off the one the connection used (§5.3). */
  reconnect?: boolean
  onConnect: () => void
  /** Connected + profile changed: disconnect and reconnect with the new profile. */
  onReconnect?: () => void
  onDisconnect: () => void
}

// The one connect control of the query page, sitting beside the target switcher. Its desktop size
// is fixed (110×46 — SPEC §7.1) so the label moving between 连接 / 已连接 / 断开 / 重新连接 never
// shifts the header; below `sm` it keeps the bottom bar's 40px height and flexes with the label.
const SIZE = 'h-10 sm:h-[46px] sm:w-[110px] gap-1.5 shrink-0'

/**
 * Not connected reads as the page's only action (brand); connected reads as a state (neutral) and
 * turns into "disconnect" on hover; connected while the selected profile changed reads "reconnect".
 * Nothing about the mechanism is explained here — the state and the label carry it.
 */
export default function ConnectButton({
  connected,
  busy,
  reconnect = false,
  onConnect,
  onReconnect,
  onDisconnect,
}: Props) {
  const { t } = useLocale()

  if (busy) {
    return (
      <button type="button" disabled aria-busy="true" className={`btn-secondary ${SIZE}`}>
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
        className={`btn-primary ${SIZE}`}
      >
        <PlugZap size={13} aria-hidden="true" />
        {t('query.connect')}
      </button>
    )
  }

  if (reconnect) {
    return (
      <button
        type="button"
        onClick={onReconnect ?? onConnect}
        aria-pressed={false}
        title={t('query.reconnect')}
        className={`btn-primary ${SIZE}`}
      >
        <PlugZap size={13} aria-hidden="true" />
        {t('query.reconnect')}
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
      className={`btn-secondary ${SIZE} group`}
    >
      <Check size={13} aria-hidden="true" className="group-hover:hidden group-focus-visible:hidden" />
      <Unplug size={13} aria-hidden="true" className="hidden group-hover:block group-focus-visible:block" />
      <span className="group-hover:hidden group-focus-visible:hidden">{t('query.connected')}</span>
      <span className="hidden group-hover:inline group-focus-visible:inline">{t('query.disconnect')}</span>
    </button>
  )
}
