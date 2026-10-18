import { describe, it, expect } from 'vitest'
import { resolveSetupView, setupErrorInfo } from '../setup'

describe('resolveSetupView', () => {
  it('shows the form when the page is enabled', () => {
    expect(resolveSetupView(true)).toBe('form')
  })

  it('shows the disabled notice when the page is disabled', () => {
    expect(resolveSetupView(false)).toBe('disabled')
  })

  it('treats a failed state request as available (form), not a blank screen', () => {
    expect(resolveSetupView(null)).toBe('form')
  })
})

describe('setupErrorInfo', () => {
  it('maps 403 to the wrong-secret message', () => {
    expect(setupErrorInfo(403, 'Invalid setup secret.', null)).toEqual({ key: 'setup.error_wrong_secret' })
  })

  it('maps 400 to the missing-secret message', () => {
    expect(setupErrorInfo(400, 'A JSON body is required.', null)).toEqual({ key: 'setup.error_missing_secret' })
  })

  it('maps 429 without Retry-After to the rate-limit message', () => {
    expect(setupErrorInfo(429, 'Too many attempts.', null)).toEqual({ key: 'setup.error_rate_limited' })
  })

  it('maps 429 with Retry-After to the retry message with the wait seconds', () => {
    expect(setupErrorInfo(429, 'Too many attempts.', '5')).toEqual({
      key: 'setup.error_rate_limited_retry',
      vars: { n: 5 },
    })
  })

  it('ignores a non-numeric Retry-After', () => {
    expect(setupErrorInfo(429, 'Too many attempts.', 'abc')).toEqual({ key: 'setup.error_rate_limited' })
  })

  it('maps a 500 mentioning SETUP_SECRET to the unconfigured-Worker message', () => {
    expect(setupErrorInfo(500, 'SETUP_SECRET is not configured on this Worker.', null)).toEqual({
      key: 'setup.error_setup_secret_unset',
    })
  })

  it('falls back to the generic error for other failures', () => {
    expect(setupErrorInfo(500, 'DDL error: something broke', null)).toEqual({ key: 'errors.generic' })
    expect(setupErrorInfo(502, 'Bad gateway', null)).toEqual({ key: 'errors.generic' })
  })
})
