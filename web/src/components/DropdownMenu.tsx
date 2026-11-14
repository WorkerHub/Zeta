import * as DropdownMenuPrimitive from '@radix-ui/react-dropdown-menu'
import { Check } from 'lucide-react'
import type { ComponentProps } from 'react'

/**
 * The one design-system dropdown (Radix `@radix-ui/react-dropdown-menu`), Nova-styled. It is the
 * gear menu's primitive set (§7.2); the data-source switcher keeps its own hand-rolled list, which
 * is out of scope here. Root / Trigger / RadioGroup are the Radix primitives unchanged; the styled
 * pieces carry the design tokens, the overlay-enter motion and the `--z-dropdown` layer.
 */
export const DropdownMenu = DropdownMenuPrimitive.Root
export const DropdownMenuTrigger = DropdownMenuPrimitive.Trigger
export const DropdownMenuRadioGroup = DropdownMenuPrimitive.RadioGroup

export function DropdownMenuContent({
  className = '',
  ...props
}: ComponentProps<typeof DropdownMenuPrimitive.Content>) {
  return (
    <DropdownMenuPrimitive.Portal>
      <DropdownMenuPrimitive.Content
        sideOffset={6}
        className={`z-(--z-dropdown) min-w-[200px] overflow-hidden rounded-lg border border-ink-200 bg-ink-0 p-1 shadow-md animate-overlay-enter ${className}`}
        {...props}
      />
    </DropdownMenuPrimitive.Portal>
  )
}

export function DropdownMenuItem({ className = '', ...props }: ComponentProps<typeof DropdownMenuPrimitive.Item>) {
  return (
    <DropdownMenuPrimitive.Item
      className={`flex cursor-pointer select-none items-center gap-2 rounded-md px-2.5 py-2 text-body text-ink-700 outline-none transition-colors duration-(--duration-fast) hover:bg-ink-100 focus:bg-ink-100 data-[disabled]:pointer-events-none data-[disabled]:opacity-50 ${className}`}
      {...props}
    />
  )
}

export function DropdownMenuRadioItem({
  className = '',
  children,
  ...props
}: ComponentProps<typeof DropdownMenuPrimitive.RadioItem>) {
  return (
    <DropdownMenuPrimitive.RadioItem
      className={`relative flex cursor-pointer select-none items-center rounded-md py-2 pl-8 pr-2.5 text-body text-ink-700 outline-none transition-colors duration-(--duration-fast) hover:bg-ink-100 focus:bg-ink-100 data-[disabled]:pointer-events-none data-[disabled]:opacity-50 ${className}`}
      {...props}
    >
      <DropdownMenuPrimitive.ItemIndicator className="absolute left-2.5 flex items-center">
        <Check size={14} className="text-brand-700 dark:text-brand-400" aria-hidden="true" />
      </DropdownMenuPrimitive.ItemIndicator>
      <span className="min-w-0 truncate">{children}</span>
    </DropdownMenuPrimitive.RadioItem>
  )
}

export function DropdownMenuLabel({ className = '', ...props }: ComponentProps<typeof DropdownMenuPrimitive.Label>) {
  return (
    <DropdownMenuPrimitive.Label
      className={`px-2.5 py-1.5 text-micro uppercase tracking-wider text-ink-400 ${className}`}
      {...props}
    />
  )
}

export function DropdownMenuSeparator({
  className = '',
  ...props
}: ComponentProps<typeof DropdownMenuPrimitive.Separator>) {
  return <DropdownMenuPrimitive.Separator className={`my-1 h-px bg-ink-200 ${className}`} {...props} />
}
