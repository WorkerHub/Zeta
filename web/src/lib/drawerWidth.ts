// Width of the run-history drawer: it opens at half the window and can be dragged between a
// minimum and 90% of the window (see components/RunHistoryDrawer.tsx).
const DEFAULT_RATIO = 0.5
const MAX_RATIO = 0.9

export const HISTORY_DRAWER_MIN_WIDTH = 360
// Pixels the arrow keys move the drawer edge; Shift makes it four times as far
export const HISTORY_DRAWER_KEY_STEP = 24

export interface DrawerWidthBounds {
  min: number
  max: number
}

// The allowed range for a window of `viewport` px. The minimum never exceeds the maximum, so a
// very narrow window still yields a usable range.
export function historyDrawerBounds(viewport: number): DrawerWidthBounds {
  const min = Math.min(HISTORY_DRAWER_MIN_WIDTH, Math.round(viewport))
  return { min, max: Math.max(min, Math.round(viewport * MAX_RATIO)) }
}

export function clampHistoryDrawerWidth(width: number, viewport: number): number {
  const { min, max } = historyDrawerBounds(viewport)
  return Math.min(max, Math.max(min, Math.round(width)))
}

// The width the drawer opens at, already clamped for small windows
export function defaultHistoryDrawerWidth(viewport: number): number {
  return clampHistoryDrawerWidth(viewport * DEFAULT_RATIO, viewport)
}
