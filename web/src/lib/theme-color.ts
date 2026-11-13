// Brand colour presets (§2.1 of docs/design-system.md). The ids travel through
// `localStorage['theme-color']` and the `data-theme-color` attribute on <html>; index.css owns
// every value. Terracotta is the default and is expressed by the attribute's absence, so both
// the pre-paint script and the hook agree on it.
//
// Once signed in the server is authoritative (GET/PUT /api/profile/theme-color); localStorage is
// only the first-paint cache that theme-init.js reads before the bundle boots.

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

/** Whether this browser holds a valid stored preset — the "local has a value" half of the sync decision. */
export function hasStoredThemeColor(): boolean {
  if (typeof localStorage === 'undefined') return false
  return isThemeColor(localStorage.getItem(THEME_COLOR_STORAGE_KEY))
}

/**
 * The first-load sync decision, kept pure so the table is unit-testable without a DOM:
 * the server wins when it answers a known id; otherwise an existing local preset is kept and
 * pushed up (`push`) so the account takes over this browser's choice; with neither, the default
 * stands and nothing is pushed.
 */
export function planThemeColorSync(
  serverRaw: unknown,
  stored: boolean,
  local: ThemeColor
): { color: ThemeColor; push: boolean } {
  if (isThemeColor(serverRaw)) return { color: serverRaw, push: false }
  if (stored) return { color: local, push: true }
  return { color: DEFAULT_THEME_COLOR, push: false }
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
