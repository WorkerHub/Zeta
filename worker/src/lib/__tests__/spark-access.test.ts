import { describe, expect, it } from 'vitest'
import { normalizeSparkAccess } from '../spark-access'

// A made-up published address: no real host or token appears here.

const URL = 'https://spark-3f9a.publish.example.dev'
const PLATFORM = 'platform-token-abc123'
const APP = 'app-token-xyz789'

const payload = (over: Record<string, unknown> = {}) => ({
  url: URL,
  platform_token: PLATFORM,
  app_token: APP,
  ...over,
})

describe('normalizeSparkAccess', () => {
  it('produces one canonical form: https, no trailing slash, no query string, no fragment', () => {
    const result = normalizeSparkAccess(payload({ url: `${URL}/?x=1#frag` }))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.access).toEqual({ url: URL, platform_token: PLATFORM, app_token: APP })
    expect(result.host).toBe('spark-3f9a.publish.example.dev')
  })

  it('keeps a real path but drops its trailing slash', () => {
    const result = normalizeSparkAccess(payload({ url: `${URL}/spark/` }))
    expect(result.ok && result.access.url).toBe(`${URL}/spark`)
  })

  it('trims surrounding whitespace off the fields', () => {
    const result = normalizeSparkAccess(
      payload({ url: ` ${URL} `, platform_token: ` ${PLATFORM} `, app_token: ` ${APP}\n` })
    )
    expect(result.ok && result.access).toEqual({ url: URL, platform_token: PLATFORM, app_token: APP })
  })

  it('refuses anything but https', () => {
    const result = normalizeSparkAccess(payload({ url: 'http://spark-3f9a.publish.example.dev' }))
    expect(result.ok).toBe(false)
    expect(!result.ok && result.error).toContain('https://')
  })

  it('refuses a URL that carries credentials', () => {
    const result = normalizeSparkAccess(payload({ url: 'https://user:password@spark-3f9a.publish.example.dev' }))
    expect(result.ok).toBe(false)
    expect(!result.ok && result.error).toContain('username or password')
  })

  it('refuses a URL that carries an address token, because tokens only travel in headers', () => {
    for (const url of [`${URL}/?_token=abc`, `${URL}/?token=abc`, `${URL}/?Access_Token=abc`]) {
      const result = normalizeSparkAccess(payload({ url }))
      expect(result.ok, url).toBe(false)
      expect(!result.ok && result.error, url).toContain('_token')
    }
  })

  it('requires both tokens', () => {
    for (const over of [{ platform_token: undefined }, { app_token: '' }, { platform_token: '   ' }]) {
      const result = normalizeSparkAccess(payload(over))
      expect(result.ok, JSON.stringify(over)).toBe(false)
      expect(!result.ok && result.error).toMatch(/required/)
    }
  })

  it('refuses a token that cannot be sent as a header value', () => {
    for (const token of ['a b', 'a\nb', 'a\tb', 'a\u0000b']) {
      const result = normalizeSparkAccess(payload({ platform_token: token }))
      expect(result.ok, JSON.stringify(token)).toBe(false)
      expect(!result.ok && result.error).toContain('spaces or line breaks')
    }
  })

  it('caps the length of the URL and of a token', () => {
    expect(normalizeSparkAccess(payload({ url: `${URL}/${'a'.repeat(2048)}` })).ok).toBe(false)
    const long = normalizeSparkAccess(payload({ app_token: 'a'.repeat(4097) }))
    expect(long.ok).toBe(false)
    expect(!long.ok && long.error).toContain('too long')
  })

  it('requires a URL and a parseable one', () => {
    expect(normalizeSparkAccess(payload({ url: '  ' })).ok).toBe(false)
    const invalid = normalizeSparkAccess(payload({ url: 'not a url' }))
    expect(invalid.ok).toBe(false)
    expect(!invalid.ok && invalid.error).toContain('not a valid publish URL')
  })

  it('never echoes the URL or a token in an error', () => {
    const cases = [
      payload({ url: 'http://spark-3f9a.publish.example.dev' }),
      payload({ url: `${URL}/?_token=${APP}` }),
      payload({ app_token: 'bad token' }),
    ]
    for (const input of cases) {
      const result = normalizeSparkAccess(input)
      expect(result.ok).toBe(false)
      const error = (result as { error: string }).error
      expect(error).not.toContain(URL)
      expect(error).not.toContain(PLATFORM)
      expect(error).not.toContain(APP)
    }
  })
})
