import { describe, it, expect, vi, afterEach } from 'vitest'
import { buildOtpEmail, buildPasswordResetEmail, sendEmail } from '../email'
import { fakeD1, fakeEnv } from '../../routes/__tests__/fakes'

function envWithSettings(settings: Record<string, string>) {
  const { db } = fakeD1((sql, args) =>
    sql.startsWith('SELECT value FROM settings') && settings[args[0] as string] !== undefined
      ? { value: settings[args[0] as string] }
      : null
  )
  return fakeEnv({ DB: db })
}

const payload = { to: 'user@example.com', subject: 'Hi', html: '<p>Hi</p>', text: 'Hi' }
const injected = 'noreply@example.com>\r\nRCPT TO:<victim@example.com'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('sendEmail sender validation', () => {
  it('refuses an SMTP from address that could inject commands', async () => {
    const env = envWithSettings({
      email_provider: 'smtp',
      smtp_config: JSON.stringify({ host: 'smtp.example.com', port: 587, from: injected }),
    })
    // The sockets stub throws if a connection were attempted
    expect(await sendEmail(env, payload)).toEqual({ success: false, error: 'Invalid sender (from) address' })
  })

  it('refuses a malformed Resend from address without calling the API', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const env = envWithSettings({
      email_provider: 'resend',
      resend_config: JSON.stringify({ api_key: 're_test', from: 'not an email' }),
    })
    expect(await sendEmail(env, payload)).toEqual({ success: false, error: 'Invalid sender (from) address' })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('sends with a valid from address', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}'))
    const env = envWithSettings({
      email_provider: 'resend',
      resend_config: JSON.stringify({ api_key: 're_test', from: 'noreply@example.com', from_name: 'Zeta' }),
    })
    expect(await sendEmail(env, payload)).toEqual({ success: true })
    const body = JSON.parse(String(fetchSpy.mock.calls[0]![1]!.body))
    expect(body.from).toBe('Zeta <noreply@example.com>')
  })
})

describe('email templates', () => {
  it('escapes single quotes along with the other HTML metacharacters', () => {
    const { html } = buildPasswordResetEmail({
      appName: `O'Brien's <b>"DB"</b> & co`,
      appUrl: "https://x.example.com/'onmouseover='alert(1)",
      toEmail: 'user@example.com',
      token: 't',
    })
    expect(html).not.toMatch(/'/)
    expect(html).toContain('&#39;onmouseover=&#39;alert(1)')

    const otp = buildOtpEmail({ appName: `O'Brien's <b>DB</b>`, toEmail: 'user@example.com', otp: '123456' })
    expect(otp.html).toContain('O&#39;Brien&#39;s &lt;b&gt;DB&lt;/b&gt;')
  })

  it('keeps the plain-text part free of HTML entities', () => {
    const { text } = buildPasswordResetEmail({
      appName: `Bob's & Co`,
      appUrl: 'https://x.example.com',
      toEmail: 'user@example.com',
      token: 't',
    })
    expect(text).toBe(`Reset your Bob's & Co password: https://x.example.com/reset-password?token=t`)
  })
})
