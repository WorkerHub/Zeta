import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { getCurrentUser } from '../lib/auth'
import { profileApi } from '../lib/api'
import { useAuthContext } from './useAuth'
import {
  applyThemeColor,
  hasStoredThemeColor,
  normalizeThemeColor,
  planThemeColorSync,
  readStoredThemeColor,
  storeThemeColor,
  type ThemeColor,
} from '../lib/theme-color'

interface ThemeColorContext {
  themeColor: ThemeColor
  setThemeColor: (color: ThemeColor) => void
  // False while the signed-in account's colour is still on the wire: the authenticated routes stay
  // on the brand-free loading shell until it flips, so the first painted frame already carries the
  // account's colour instead of the default.
  ready: boolean
  // Set when a user-initiated change failed to save and was rolled back; cleared on the next pick.
  syncError: boolean
}

const Ctx = createContext<ThemeColorContext | null>(null)

export function ThemeColorProvider({ children }: { children: ReactNode }) {
  const { user } = useAuthContext()
  const [themeColor, setThemeColorState] = useState<ThemeColor>(() => readStoredThemeColor())
  const [bootFor, setBootFor] = useState<string | null>(null)
  const [syncError, setSyncError] = useState(false)

  // The last colour the server acknowledged (from GET or a successful PUT); a failed switch rolls
  // back to it.
  const baselineRef = useRef<ThemeColor>(themeColor)
  // Monotonic token: only the most recent PUT may settle the screen, older replies are ignored.
  const putTokenRef = useRef(0)
  // Which user id is currently being fetched, so StrictMode's double-run fires one request.
  const inFlightFor = useRef<string | null>(null)

  const ready = user == null ? true : bootFor === user.id

  const applyLocal = useCallback((color: ThemeColor) => {
    applyThemeColor(color)
    storeThemeColor(color)
    setThemeColorState(color)
  }, [])

  const setThemeColor = useCallback(
    (next: ThemeColor) => {
      setSyncError(false)
      applyLocal(next)
      if (user == null) return // anonymous: local only, no request

      const token = ++putTokenRef.current
      profileApi
        .updateThemeColor(next)
        .then((res) => {
          if (token !== putTokenRef.current) return
          const confirmed = normalizeThemeColor(res.theme_color)
          if (confirmed !== next) applyLocal(confirmed)
          baselineRef.current = confirmed
        })
        .catch(() => {
          if (token !== putTokenRef.current) return
          applyLocal(baselineRef.current)
          setSyncError(true)
        })
    },
    [user, applyLocal]
  )

  useEffect(() => {
    if (user == null) {
      setBootFor(null)
      setSyncError(false)
      inFlightFor.current = null
      baselineRef.current = readStoredThemeColor()
      return
    }
    if (inFlightFor.current === user.id || bootFor === user.id) return
    inFlightFor.current = user.id
    const userId = user.id

    ;(async () => {
      let plan: { color: ThemeColor; push: boolean }
      try {
        const res = await profileApi.themeColor()
        plan = planThemeColorSync(res.theme_color, hasStoredThemeColor(), readStoredThemeColor())
      } catch {
        // Server unreachable / not deployed yet: keep the local colour and carry on.
        plan = { color: readStoredThemeColor(), push: false }
      }
      // Apply only if still the same signed-in user (guards unmount, logout and account switch).
      if (getCurrentUser()?.id !== userId) return
      baselineRef.current = plan.color
      applyLocal(plan.color)
      setBootFor(userId)
      if (plan.push) {
        // Take over the account with this browser's choice, in the background: nothing on screen
        // changes, and a failure is retried on the next signed-in load.
        profileApi.updateThemeColor(plan.color).catch(() => {})
      }
    })()
  }, [user, bootFor, applyLocal])

  return <Ctx.Provider value={{ themeColor, setThemeColor, ready, syncError }}>{children}</Ctx.Provider>
}

export function useThemeColor(): ThemeColorContext {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useThemeColor must be inside ThemeColorProvider')
  return ctx
}
