// Brand colour presets (§2.1 of docs/design-system.md). The ids travel through
// `localStorage['theme-color']` and the `data-theme-color` attribute on <html>; index.css owns
// every value. Terracotta is the default and is expressed by the attribute's absence, so both
// the pre-paint script and the hook agree on it.

export const THEME_COLOR_STORAGE_KEY = 'theme-color'

export type ThemeColor = 'terracotta' | 'ocean' | 'teal' | 'forest' | 'grape' | 'rose'

export const DEFAULT_THEME_COLOR: ThemeColor = 'terracotta'

// Display order of the picker; terracotta first because it is the default
export const THEME_COLORS: readonly ThemeColor[] = ['terracotta', 'ocean', 'teal', 'forest', 'grape', 'rose']

export function isThemeColor(value: unknown): value is ThemeColor {
  return typeof value === 'string' && (THEME_COLORS as readonly string[]).includes(value)
}

/** Anything that is not a known preset id falls back to the default, silently. */
export function normalizeThemeColor(value: string | null | undefined): ThemeColor {
  return isThemeColor(value) ? value : DEFAULT_THEME_COLOR
}

export function readStoredThemeColor(): ThemeColor {
  if (typeof localStorage === 'undefined') return DEFAULT_THEME_COLOR
  return normalizeThemeColor(localStorage.getItem(THEME_COLOR_STORAGE_KEY))
}

export function storeThemeColor(color: ThemeColor): void {
  if (typeof localStorage === 'undefined') return
  localStorage.setItem(THEME_COLOR_STORAGE_KEY, color)
}

/**
 * Paints the preset by toggling the attribute every preset block in index.css is keyed on.
 * Terracotta removes it — the `@theme` defaults are terracotta, so the attribute stays absent
 * for the default instead of appearing and disappearing around hydration.
 */
export function applyThemeColor(color: ThemeColor): void {
  if (typeof document === 'undefined') return
  const html = document.documentElement
  if (color === DEFAULT_THEME_COLOR) html.removeAttribute('data-theme-color')
  else html.setAttribute('data-theme-color', color)
}
