import { describe, expect, it } from 'vitest'
import { hasLivyConfig, hasSparkUi, normalizeSparkAccess } from '../spark-access'

// A made-up published address: no real host or token appears here.

const URL = 'https://spark-3f9a.publish.example.dev'
const PLATFORM = 'platform-token-abc123'
const APP = 'app-token-xyz789'
const UI_URL = 'https://spark-ui-4040.publish.example.dev'
const UI_TOKEN = 'ui-platform-token-999'
const LIVY_URL = 'https://livy-3f9a.publish.example.dev'
const LIVY_TOKEN = 'livy-token-qwe456'

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

  it('accepts paired optional ui_url and ui_platform_token', () => {
    const result = normalizeSparkAccess(
      payload({
        ui_url: `${UI_URL}/proxy/app-1/`,
        ui_platform_token: UI_TOKEN,
      })
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.access.ui_url).toBe(`${UI_URL}/proxy/app-1`)
    expect(result.access.ui_platform_token).toBe(UI_TOKEN)
    expect(hasSparkUi(result.access)).toBe(true)
  })

  it('enforces that ui_url and ui_platform_token must be paired (both empty or both filled)', () => {
    const withUrlOnly = normalizeSparkAccess(payload({ ui_url: UI_URL }))
    expect(withUrlOnly.ok).toBe(false)
    expect(!withUrlOnly.ok && withUrlOnly.error).toContain('both be provided or both omitted')

    const withTokenOnly = normalizeSparkAccess(payload({ ui_platform_token: UI_TOKEN }))
    expect(withTokenOnly.ok).toBe(false)
    expect(!withTokenOnly.ok && withTokenOnly.error).toContain('both be provided or both omitted')
  })

  it('validates ui_url with the same rules as publish url (https, no credentials, no tokens, <= 2048)', () => {
    const notHttps = normalizeSparkAccess(payload({ ui_url: 'http://spark-ui.dev', ui_platform_token: UI_TOKEN }))
    expect(notHttps.ok).toBe(false)
    expect(!notHttps.ok && notHttps.error).toContain('https://')

    const withCreds = normalizeSparkAccess(payload({ ui_url: 'https://u:p@spark-ui.dev', ui_platform_token: UI_TOKEN }))
    expect(withCreds.ok).toBe(false)
    expect(!withCreds.ok && withCreds.error).toContain('username or password')

    const withTokenParam = normalizeSparkAccess(
      payload({ ui_url: `${UI_URL}/?_token=xyz`, ui_platform_token: UI_TOKEN })
    )
    expect(withTokenParam.ok).toBe(false)
    expect(!withTokenParam.ok && withTokenParam.error).toContain('_token')

    const tooLong = normalizeSparkAccess(
      payload({ ui_url: `${UI_URL}/${'a'.repeat(2048)}`, ui_platform_token: UI_TOKEN })
    )
    expect(tooLong.ok).toBe(false)
    expect(!tooLong.ok && tooLong.error).toContain('too long')
  })

  it('validates ui_platform_token (non-empty, <= 4096, no control characters)', () => {
    const withSpace = normalizeSparkAccess(payload({ ui_url: UI_URL, ui_platform_token: 'bad token' }))
    expect(withSpace.ok).toBe(false)
    expect(!withSpace.ok && withSpace.error).toContain('spaces or line breaks')

    const tooLong = normalizeSparkAccess(payload({ ui_url: UI_URL, ui_platform_token: 'a'.repeat(4097) }))
    expect(tooLong.ok).toBe(false)
    expect(!tooLong.ok && tooLong.error).toContain('too long')
  })

  it('hasSparkUi correctly evaluates payloads', () => {
    expect(hasSparkUi(null)).toBe(false)
    expect(hasSparkUi({})).toBe(false)
    expect(hasSparkUi({ ui_url: UI_URL })).toBe(false)
    expect(hasSparkUi({ ui_platform_token: UI_TOKEN })).toBe(false)
    expect(hasSparkUi({ ui_url: '', ui_platform_token: UI_TOKEN })).toBe(false)
    expect(hasSparkUi({ ui_url: UI_URL, ui_platform_token: UI_TOKEN })).toBe(true)
  })

  describe('livy fields', () => {
    it('accepts valid livy_url and livy_platform_token and normalises the URL', () => {
      const result = normalizeSparkAccess(
        payload({
          livy_url: `${LIVY_URL}/?x=1#frag`,
          livy_platform_token: `  ${LIVY_TOKEN}  `,
        })
      )
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.access.livy_url).toBe(LIVY_URL)
      expect(result.access.livy_platform_token).toBe(LIVY_TOKEN)
      expect(hasLivyConfig(result.access)).toBe(true)
    })

    it('requires livy_url and livy_platform_token to be paired (both present or both absent)', () => {
      const onlyUrl = normalizeSparkAccess(payload({ livy_url: LIVY_URL }))
      expect(onlyUrl.ok).toBe(false)
      expect(!onlyUrl.ok && onlyUrl.error).toContain('together')

      const onlyToken = normalizeSparkAccess(payload({ livy_platform_token: LIVY_TOKEN }))
      expect(onlyToken.ok).toBe(false)
      expect(!onlyToken.ok && onlyToken.error).toContain('together')

      const bothEmpty = normalizeSparkAccess(payload({ livy_url: '  ', livy_platform_token: '' }))
      expect(bothEmpty.ok).toBe(true)
      if (!bothEmpty.ok) return
      expect(bothEmpty.access.livy_url).toBeUndefined()
      expect(bothEmpty.access.livy_platform_token).toBeUndefined()
      expect(hasLivyConfig(bothEmpty.access)).toBe(false)
    })

    it('refuses invalid Livy URL (http, credentials, address tokens, too long)', () => {
      const http = normalizeSparkAccess(
        payload({ livy_url: 'http://livy.example.com', livy_platform_token: LIVY_TOKEN })
      )
      expect(http.ok).toBe(false)

      const creds = normalizeSparkAccess(
        payload({ livy_url: 'https://user:pass@livy.example.com', livy_platform_token: LIVY_TOKEN })
      )
      expect(creds.ok).toBe(false)

      const tokenParam = normalizeSparkAccess(
        payload({ livy_url: `${LIVY_URL}?_token=123`, livy_platform_token: LIVY_TOKEN })
      )
      expect(tokenParam.ok).toBe(false)

      const tooLong = normalizeSparkAccess(
        payload({ livy_url: `${LIVY_URL}/${'a'.repeat(2048)}`, livy_platform_token: LIVY_TOKEN })
      )
      expect(tooLong.ok).toBe(false)
    })

    it('refuses invalid Livy platform token (whitespace, control characters, too long)', () => {
      for (const token of ['a b', 'a\nb', 'a\tb', 'a\u0000b']) {
        const res = normalizeSparkAccess(payload({ livy_url: LIVY_URL, livy_platform_token: token }))
        expect(res.ok).toBe(false)
        expect(!res.ok && res.error).toContain('spaces or line breaks')
      }

      const tooLong = normalizeSparkAccess(payload({ livy_url: LIVY_URL, livy_platform_token: 'a'.repeat(4097) }))
      expect(tooLong.ok).toBe(false)
    })

    it('never echoes Livy URL or Livy token in errors', () => {
      const cases = [
        payload({ livy_url: 'http://livy.example.com', livy_platform_token: LIVY_TOKEN }),
        payload({ livy_url: `${LIVY_URL}?_token=secret`, livy_platform_token: LIVY_TOKEN }),
        payload({ livy_url: LIVY_URL, livy_platform_token: 'bad token' }),
      ]
      for (const input of cases) {
        const result = normalizeSparkAccess(input)
        expect(result.ok).toBe(false)
        const error = (result as { error: string }).error
        expect(error).not.toContain(LIVY_URL)
        expect(error).not.toContain(LIVY_TOKEN)
      }
    })
  })
})
