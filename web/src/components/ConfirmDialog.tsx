import { useEffect, useRef } from 'react'
import { AlertTriangle } from 'lucide-react'
import { useLocale } from '../hooks/useLocale'

interface Props {
  title: string
  description: string
  confirmLabel?: string
  cancelLabel?: string
  /** Called when the user confirms; the parent owns async state and closing. */
  onConfirm: () => void
  onCancel: () => void
  busy?: boolean
}

/**
 * Design-system confirmation dialog — replaces window.confirm (§3.1 micro_interaction).
 * Esc/backdrop cancel, focus moves in on open and back out on unmount, Tab is trapped.
 */
export default function ConfirmDialog({
  title,
  description,
  confirmLabel,
  cancelLabel,
  onConfirm,
  onCancel,
  busy = false,
}: Props) {
  const { t } = useLocale()
  const confirmRef = useRef<HTMLButtonElement>(null)

  // Focus the destructive action on open; return focus to whatever opened the dialog
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    confirmRef.current?.focus()
    return () => {
      if (previous?.isConnected) previous.focus()
    }
  }, [])

  // Esc cancels from anywhere
  useEffect(() => {
    const onKeyDown = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        if (!busy) onCancel()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onCancel, busy])

  return (
    <div className="fixed inset-0 z-(--z-modal) flex items-center justify-center p-4">
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: backdrop is pointer-only; Esc and the cancel button close the dialog */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: pointer-only dismiss target */}
      <div
        className="absolute inset-0 bg-ink-950/50 backdrop-blur-sm animate-overlay-enter"
        onClick={() => {
          if (!busy) onCancel()
        }}
      />
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
        aria-describedby="confirm-dialog-desc"
        className="card relative w-full max-w-sm rounded-xl p-6 shadow-lg animate-modal-enter"
        onKeyDown={(e) => {
          // Two-button dialog: wrap Tab between cancel and confirm
          if (e.key !== 'Tab') return
          const buttons = e.currentTarget.querySelectorAll<HTMLButtonElement>('button:not([disabled])')
          const first = buttons[0]
          const last = buttons[buttons.length - 1]
          if (!first || !last) return
          if (e.shiftKey && document.activeElement === first) {
            e.preventDefault()
            last.focus()
          } else if (!e.shiftKey && document.activeElement === last) {
            e.preventDefault()
            first.focus()
          }
        }}
      >
        <div className="flex items-start gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-danger-50 text-danger-600">
            <AlertTriangle size={16} aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <h2 id="confirm-dialog-title" className="text-heading text-ink-950">
              {title}
            </h2>
            <p id="confirm-dialog-desc" className="mt-1 text-body text-ink-500">
              {description}
            </p>
          </div>
        </div>
        <div className="mt-6 flex gap-3">
          <button type="button" onClick={onCancel} disabled={busy} className="btn-secondary flex-1">
            {cancelLabel ?? t('common.cancel')}
          </button>
          <button ref={confirmRef} type="button" onClick={onConfirm} disabled={busy} className="btn-danger flex-1">
            {confirmLabel ?? t('common.confirm')}
          </button>
        </div>
      </div>
    </div>
  )
}
