import { describe, it, expect, vi, afterEach } from 'vitest'
import { otpCode } from '../id'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('otpCode', () => {
  it('returns six digits', () => {
    for (let i = 0; i < 50; i++) expect(otpCode()).toMatch(/^[1-9]\d{5}$/)
  })

  it('redraws values from the incomplete top range instead of folding them onto low codes', () => {
    const top = 2 ** 32 - 1 // 4294967295 % 900000 would yield 167295 → code 267295
    const draws = [top, 5]
    vi.spyOn(crypto, 'getRandomValues').mockImplementation(<T extends ArrayBufferView | null>(buf: T): T => {
      ;(buf as unknown as Uint32Array)[0] = draws.shift()!
      return buf
    })
    expect(otpCode()).toBe('100005')
    expect(draws).toHaveLength(0)
  })
})
