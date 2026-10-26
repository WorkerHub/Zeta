import { describe, it, expect } from 'vitest'
import { resolveAppOrigin, resolveRpID } from '../app-url'

const ctx = (APP_URL: string | undefined, url = 'http://localhost:8787/api/health') => ({
  env: { APP_URL },
  req: { url },
})

describe('resolveAppOrigin', () => {
  it('uses a configured APP_URL, normalized exactly like the old direct reads', () => {
    expect(resolveAppOrigin(ctx('https://zeta.example.com/'))).toBe('https://zeta.example.com')
    expect(resolveAppOrigin(ctx('  https://zeta.example.com/  '))).toBe('https://zeta.example.com')
    expect(resolveAppOrigin(ctx('https://zeta.example.com'))).toBe('https://zeta.example.com')
    // Only a trailing slash is stripped; the rest of the configured URL is left as it was
    expect(resolveAppOrigin(ctx('https://zeta.example.com/base/', 'https://other.example.com/x'))).toBe(
      'https://zeta.example.com/base'
    )
  })

  it('derives the origin from the request when APP_URL is unset', () => {
    expect(resolveAppOrigin(ctx(undefined, 'https://zeta.example.com/api/auth/login'))).toBe('https://zeta.example.com')
    expect(resolveAppOrigin(ctx('', 'http://localhost:8787/api/health'))).toBe('http://localhost:8787')
    expect(resolveAppOrigin(ctx('   ', 'https://zeta.example.com:8443/api/health'))).toBe(
      'https://zeta.example.com:8443'
    )
  })

  it('has no production fallback: an unconfigured local request stays local', () => {
    expect(resolveAppOrigin(ctx(undefined, 'http://localhost:8787/'))).toBe('http://localhost:8787')
  })
})

describe('resolveRpID', () => {
  it('is the hostname of the configured origin', () => {
    expect(resolveRpID(ctx('https://zeta.example.com/'))).toBe('zeta.example.com')
  })

  it('is the hostname of the request origin when APP_URL is unset', () => {
    expect(resolveRpID(ctx(undefined, 'https://zeta.example.com/api/profile/passkey/register/options'))).toBe(
      'zeta.example.com'
    )
    expect(resolveRpID(ctx(undefined, 'http://localhost:8787/api/profile/passkey/register/options'))).toBe('localhost')
  })
})
