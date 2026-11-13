import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { getCurrentUser } from '../lib/auth'
import { ApiError, profileApi } from '../lib/api'
import { useAuthContext } from './useAuth'
import { useLocale } from './useLocale'
import {
  applyThemeColor,
  hasStoredThemeColor,
  normalizeThemeColor,
  planThemeColorSync,
  readStoredThemeColor,
  rollbackThemeColor,
  storeThemeColor,
  themeSaveErrorMessage,
  type ThemeColor,
} from '../lib/theme-color'

// How long the signed-in boot waits for the server value before giving up and falling back to the
// cached colour. The authenticated routes stay gated until this settles, so a hung request must
// not be able to pin the app on the loading shell forever.
const THEME_BOOT_TIMEOUT_MS = 4000

interface ThemeColorContext {
  themeColor: ThemeColor
  setThemeColor: (color: ThemeColor) => void
  // False while the signed-in account's colour is still on the wire: the authenticated routes stay
  // on the brand-free loading shell until it flips, so the first painted frame already carries the
  // account's colour instead of the default.
  ready: boolean
  // What to show when a user-initiated change failed to save and was rolled back (null = none).
  syncError: string | null
}

const Ctx = createContext<ThemeColorContext | null>(null)

export function ThemeColorProvider({ children }: { children: ReactNode }) {
  const { user } = useAuthContext()
  const { t } = useLocale()
  const [themeColor, setThemeColorState] = useState<ThemeColor>(() => readStoredThemeColor())
  const [bootFor, setBootFor] = useState<string | null>(null)
  const [syncError, setSyncError] = useState<string | null>(null)

  // The last colour the server acknowledged (from the boot GET or a successful PUT); a failed
  // switch rolls back to it. Null until the first boot answer — before that, a failed switch
  // rolls back to the colour that was on screen before it.
  const baselineRef = useRef<ThemeColor | null>(null)
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
      const previous = themeColor
      setSyncError(null)
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
        .catch((err: unknown) => {
          if (token !== putTokenRef.current) return
          applyLocal(rollbackThemeColor(baselineRef.current, previous))
          const status = err instanceof ApiError ? err.status : undefined
          const message = err instanceof ApiError ? err.message : undefined
          setSyncError(themeSaveErrorMessage(status, message, t('errors.theme_color_save_failed')))
        })
    },
    [user, themeColor, applyLocal, t]
  )

  useEffect(() => {
    if (user == null) {
      setBootFor(null)
      setSyncError(null)
      inFlightFor.current = null
      baselineRef.current = null
      return
    }
    if (inFlightFor.current === user.id || bootFor === user.id) return
    inFlightFor.current = user.id
    const userId = user.id

    ;(async () => {
      let plan: { color: ThemeColor; push: boolean }
      try {
        const res = await profileApi.themeColor(AbortSignal.timeout(THEME_BOOT_TIMEOUT_MS))
        plan = planThemeColorSync(res.theme_color, hasStoredThemeColor(), readStoredThemeColor())
      } catch {
        // Server unreachable / not deployed yet / timed out: keep the local colour and carry on.
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
