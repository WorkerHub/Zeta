import type { Env } from '../types'
import { getSetting } from './db'
import { connect } from 'cloudflare:sockets'

const EMAIL_RE = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/

function isValidEmail(email: string): boolean {
  return EMAIL_RE.test(email) && !email.includes('\r') && !email.includes('\n')
}

export interface EmailPayload {
  to: string
  subject: string
  html: string
  text: string
  from?: string
  fromName?: string
}

interface SMTPConfig {
  host: string
  port: number
  username: string
  password: string
  from: string
  from_name: string
  secure: boolean
}

interface ResendConfig {
  api_key: string
  from: string
  from_name: string
}

export async function sendEmail(env: Env, payload: EmailPayload): Promise<{ success: boolean; error?: string }> {
  if (!isValidEmail(payload.to)) {
    return { success: false, error: 'Invalid recipient email address' }
  }

  const provider = await getSetting(env, 'email_provider')

  if (!provider || provider === 'none') {
    return { success: false, error: 'No email provider configured' }
  }

  if (provider === 'resend') {
    return sendViaResend(env, payload)
  }

  if (provider === 'smtp') {
    return sendViaSMTP(env, payload)
  }

  return { success: false, error: `Unknown email provider: ${provider}` }
}

async function sendViaResend(env: Env, payload: EmailPayload): Promise<{ success: boolean; error?: string }> {
  const configStr = await getSetting(env, 'resend_config')
  if (!configStr) return { success: false, error: 'Resend not configured' }

  const config: ResendConfig = JSON.parse(configStr)
  if (!config.api_key) return { success: false, error: 'Resend API key not configured' }

  const from = payload.from || config.from || 'noreply@example.com'
  const fromName = (payload.fromName || config.from_name || 'Zeta').replace(/[\r\n]/g, '')

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${config.api_key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: `${fromName} <${from}>`,
      to: [payload.to],
      subject: payload.subject,
      html: payload.html,
    }),
  })

  if (!response.ok) {
    const err = await response.text()
    return { success: false, error: `Resend error: ${err}` }
  }

  return { success: true }
}

async function sendViaSMTP(env: Env, payload: EmailPayload): Promise<{ success: boolean; error?: string }> {
  const configStr = await getSetting(env, 'smtp_config')
  if (!configStr) return { success: false, error: 'SMTP not configured' }

  const config: SMTPConfig = JSON.parse(configStr)
  if (!config.host) return { success: false, error: 'SMTP host not configured' }

  const from = payload.from || config.from || 'noreply@example.com'
  const fromName = (payload.fromName || config.from_name || 'Zeta').replace(/[\r\n]/g, '')
  const isImplicitTls = config.port === 465

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const socket: any = connect(
    { hostname: config.host, port: config.port },
    { secureTransport: isImplicitTls ? 'on' : 'off' } as any,
  )

  try {
    const session = new SmtpSession(socket)

    await session.expect(220)
    await session.cmd('EHLO zeta')
    await session.expect(250)

    if (!isImplicitTls) {
      await session.tryStartTls()
    }

    if (config.username && config.password) {
      await session.authLogin(config.username, config.password)
    }

    await session.sendMessage(from, fromName, payload.to, payload.subject, payload.html)
    await session.quit()

    return { success: true }
  } catch (err) {
    return { success: false, error: `SMTP error: ${err instanceof Error ? err.message : String(err)}` }
  } finally {
    await socket.close().catch(() => {})
  }
}

class SmtpSession {
  private buf = ''
  private readonly dec = new TextDecoder()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private socket: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private reader: ReadableStreamDefaultReader<any>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private writer: WritableStreamDefaultWriter<any>

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(socket: any) {
    this.socket = socket
    this.reader = socket.readable.getReader()
    this.writer = socket.writable.getWriter()
  }

  async tryStartTls(): Promise<void> {
    await this.cmd('STARTTLS')
    const resp = await this.readResponse()
    if (resp.code !== 220) return

    this.reader.releaseLock()
    this.writer.releaseLock()

    const tls = this.socket.startTls()
    this.socket = tls
    this.reader = tls.readable.getReader()
    this.writer = tls.writable.getWriter()
    this.buf = ''

    await this.cmd('EHLO zeta')
    await this.expect(250)
  }

  async authLogin(user: string, pass: string): Promise<void> {
    await this.cmd('AUTH LOGIN')
    await this.expect(334)
    await this.cmd(btoa(user))
    await this.expect(334)
    await this.cmd(btoa(pass))
    await this.expect(235)
  }

  async sendMessage(from: string, fromName: string, to: string, subject: string, html: string): Promise<void> {
    await this.cmd(`MAIL FROM:<${from}>`)
    await this.expect(250)
    await this.cmd(`RCPT TO:<${to}>`)
    await this.expect(250)
    await this.cmd('DATA')
    await this.expect(354)

    const date = new Date().toUTCString()
    const msgId = `<${Date.now()}.${Math.random().toString(36).slice(2)}@zeta>`
    const b64Body = wrapBase64(encodeUtf8Base64(html))
    const encodedSubject = `=?UTF-8?B?${encodeUtf8Base64(subject)}?=`

    const message =
      `From: ${fromName} <${from}>\r\n` +
      `To: ${to}\r\n` +
      `Subject: ${encodedSubject}\r\n` +
      `Date: ${date}\r\n` +
      `Message-ID: ${msgId}\r\n` +
      `MIME-Version: 1.0\r\n` +
      `Content-Type: text/html; charset=UTF-8\r\n` +
      `Content-Transfer-Encoding: base64\r\n` +
      `\r\n` +
      `${b64Body}\r\n` +
      `.\r\n`

    await this.writer.write(new TextEncoder().encode(message))
    await this.expect(250)
  }

  async quit(): Promise<void> {
    await this.cmd('QUIT').catch(() => {})
  }

  async cmd(text: string): Promise<void> {
    await this.writer.write(new TextEncoder().encode(text + '\r\n'))
  }

  async expect(code: number): Promise<void> {
    const resp = await this.readResponse()
    if (resp.code !== code) {
      throw new Error(`SMTP: expected ${code}, got ${resp.code} — ${resp.message}`)
    }
  }

  async readResponse(): Promise<{ code: number; message: string }> {
    const lines: string[] = []
    for (;;) {
      while (!this.buf.includes('\r\n')) {
        const { value, done } = await this.reader.read()
        if (done) throw new Error('SMTP: connection closed unexpectedly')
        this.buf += this.dec.decode(value)
      }

      const eol = this.buf.indexOf('\r\n')
      const line = this.buf.slice(0, eol)
      this.buf = this.buf.slice(eol + 2)
      lines.push(line)

      // RFC 5321: last line has space at position 3; continuation lines have '-'
      if (line.length <= 3 || line[3] === ' ') {
        const code = parseInt(line.slice(0, 3), 10)
        if (isNaN(code)) throw new Error(`SMTP: invalid response line: ${line}`)
        return { code, message: lines.map((l) => l.slice(4)).join('\n') }
      }
    }
  }
}

function encodeUtf8Base64(str: string): string {
  const bytes = new TextEncoder().encode(str)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function wrapBase64(b64: string): string {
  return b64.match(/.{1,76}/g)?.join('\r\n') ?? b64
}

// ── Template helpers ──────────────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

export function buildVerificationEmail(opts: {
  appName: string
  appUrl: string
  toEmail: string
  token: string
}): EmailPayload {
  const link = `${opts.appUrl}/verify-email?token=${encodeURIComponent(opts.token)}`
  const safeName = escapeHtml(opts.appName)
  const safeLink = escapeHtml(link)
  return {
    to: opts.toEmail,
    subject: `Verify your ${opts.appName} email`,
    html: `<p>Click <a href="${safeLink}">here</a> to verify your email address. This link expires in 24 hours.</p>`,
    text: `Verify your ${safeName} email: ${link}`,
  }
}

export function buildPasswordResetEmail(opts: {
  appName: string
  appUrl: string
  toEmail: string
  token: string
}): EmailPayload {
  const link = `${opts.appUrl}/reset-password?token=${encodeURIComponent(opts.token)}`
  const safeName = escapeHtml(opts.appName)
  const safeLink = escapeHtml(link)
  return {
    to: opts.toEmail,
    subject: `Reset your ${opts.appName} password`,
    html: `<p>Click <a href="${safeLink}">here</a> to reset your password. This link expires in 1 hour.</p>`,
    text: `Reset your ${safeName} password: ${link}`,
  }
}

export function buildOtpEmail(opts: {
  appName: string
  toEmail: string
  otp: string
}): EmailPayload {
  const safeName = escapeHtml(opts.appName)
  return {
    to: opts.toEmail,
    subject: `Your ${opts.appName} verification code`,
    html: `<p>Your ${safeName} verification code is: <strong>${escapeHtml(opts.otp)}</strong>. It expires in 10 minutes.</p>`,
    text: `Your ${opts.appName} verification code: ${opts.otp}`,
  }
}
