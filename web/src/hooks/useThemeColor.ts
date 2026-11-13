import { useEffect, useState } from 'react'
import { applyThemeColor, readStoredThemeColor, storeThemeColor, type ThemeColor } from '../lib/theme-color'

/**
 * Brand colour preset, shaped like `useTheme`: the state starts from what this browser stored,
 * and every change both paints <html> and persists. Orthogonal to the light/dark theme — that one
 * owns the `.dark` class, this one owns `data-theme-color`.
 */
export function useThemeColor() {
  const [themeColor, setThemeColor] = useState<ThemeColor>(() => readStoredThemeColor())

  useEffect(() => {
    applyThemeColor(themeColor)
    storeThemeColor(themeColor)
  }, [themeColor])

  return { themeColor, setThemeColor }
}
