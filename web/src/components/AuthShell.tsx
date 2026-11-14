import type { ReactNode } from 'react'
import { useEffect } from 'react'

/**
 * Shared shell for the signed-out pages (login / register / forgot-password /
 * reset-password / verify-email / setup).
 *
 * These pages must be fully locked against scroll and rubber-banding: on iOS
 * (PWA standalone) the previous `min-h-screen` measured `100vh`, which overcounts
 * the visible area, so the page sat a few px taller than the viewport and panned
 * in both axes when dragged. The fix is all native CSS (see `.auth-shell` /
 * `.auth-scroll` / `html.auth-locked` in index.css); this component only toggles
 * the `auth-locked` class on <html> for the page's lifetime — the same class-toggle
 * pattern hooks/useTheme.ts uses for `.dark`.
 */
export default function AuthShell({ children, toolbar }: { children: ReactNode; toolbar?: ReactNode }) {
  useEffect(() => {
    const html = document.documentElement
    html.classList.add('auth-locked')
    return () => html.classList.remove('auth-locked')
  }, [])

  return (
    <div className="auth-shell bg-ink-50">
      {toolbar}
      <div className="auth-scroll">{children}</div>
    </div>
  )
}
