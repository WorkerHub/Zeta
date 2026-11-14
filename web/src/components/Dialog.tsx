import * as DialogPrimitive from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import type { ReactNode } from 'react'
import { useLocale } from '../hooks/useLocale'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Visible heading; also used as the accessible name. */
  title: ReactNode
  /** Accessible description; Radix requires one. Defaults to the title (screen-reader only). */
  description?: ReactNode
  children: ReactNode
  /** Content width / extra classes; the shared frame fills its slot and centers itself. */
  className?: string
}

/**
 * The one design-system dialog (Radix `@radix-ui/react-dialog`), shared by every floating form that
 * is not a confirmation — §7.3's manage-config dialog now, #56's instance-config dialog later. It
 * centers like `ConfirmDialog` (no transform conflict with the modal-enter keyframe), closes on
 * Esc/backdrop, traps focus and hands it back, and renders the title plus a close X. Exit is an
 * instant dismiss, matching the frozen motion language (see index.css §2.6).
 */
export default function Dialog({ open, onOpenChange, title, description, children, className = '' }: Props) {
  const { t } = useLocale()
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <div className="fixed inset-0 z-(--z-modal) flex items-center justify-center p-4">
          <DialogPrimitive.Overlay className="absolute inset-0 bg-ink-950/50 backdrop-blur-sm animate-overlay-enter" />
          <DialogPrimitive.Content
            className={`card relative flex max-h-full w-full flex-col animate-modal-enter focus:outline-none ${
              className || 'max-w-lg'
            }`}
          >
            <div className="flex shrink-0 items-center justify-between gap-3 border-b border-ink-200 px-5 py-3.5">
              <DialogPrimitive.Title className="text-heading text-ink-950">{title}</DialogPrimitive.Title>
              <DialogPrimitive.Close
                className="rounded p-1 text-ink-400 hover:bg-ink-100 hover:text-ink-700 transition-colors duration-(--duration-base)"
                aria-label={t('common.dismiss')}
              >
                <X size={16} aria-hidden="true" />
              </DialogPrimitive.Close>
            </div>
            <DialogPrimitive.Description className="sr-only">{description ?? title}</DialogPrimitive.Description>
            {children}
          </DialogPrimitive.Content>
        </div>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
