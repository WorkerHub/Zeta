import { describe, it, expect } from 'vitest'
import {
  HISTORY_DRAWER_MIN_WIDTH,
  clampHistoryDrawerWidth,
  defaultHistoryDrawerWidth,
  historyDrawerBounds,
} from '../drawerWidth'

describe('historyDrawerBounds', () => {
  it('allows between 360px and 90% of a normal window', () => {
    expect(historyDrawerBounds(1600)).toEqual({ min: 360, max: 1440 })
  })

  it('never lets the minimum exceed the maximum on a narrow window', () => {
    const { min, max } = historyDrawerBounds(400)
    expect(min).toBeLessThanOrEqual(max)
    expect(max).toBe(360)
  })
})

describe('defaultHistoryDrawerWidth', () => {
  it('opens at half the window', () => {
    expect(defaultHistoryDrawerWidth(1440)).toBe(720)
  })

  it('rounds to whole pixels', () => {
    expect(defaultHistoryDrawerWidth(1281)).toBe(641)
  })

  it('keeps at least the minimum width on a small window', () => {
    expect(defaultHistoryDrawerWidth(600)).toBe(HISTORY_DRAWER_MIN_WIDTH)
  })
})

describe('clampHistoryDrawerWidth', () => {
  it('keeps a dragged width inside the allowed range', () => {
    expect(clampHistoryDrawerWidth(100, 1600)).toBe(HISTORY_DRAWER_MIN_WIDTH)
    expect(clampHistoryDrawerWidth(5000, 1600)).toBe(1440)
    expect(clampHistoryDrawerWidth(800, 1600)).toBe(800)
  })

  it('rounds fractional widths to whole pixels', () => {
    expect(clampHistoryDrawerWidth(800.6, 1600)).toBe(801)
  })

  it('follows a shrunk window down to its new maximum', () => {
    expect(clampHistoryDrawerWidth(1440, 800)).toBe(720)
  })
})
