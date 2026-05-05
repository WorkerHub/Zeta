import type { Env } from '../types'
import { getSettings } from './db'

export interface EmailPayload {
  to: string
  subject: string
  html: string
  text: string
}

export async function sendEmail(env: Env, payload: EmailPayload): Promise<void> {
  const cfg = await getSettings(env, [
    'email_provider', 'resend_api_key',
    'smtp_host', 'smtp_port', 'smtp_user', 'smtp_pass', 'smtp_from',
    'app_name',
  ])

  const from = cfg['smtp_from'] || 'noreply@zeta.app'
  const provider = cfg['email_provider'] || 'resend'

  if (provider === 'resend') {
    const apiKey = cfg['resend_api_key']
    if (!apiKey) throw new Error('Resend API key not configured')
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to: [payload.to], subject: payload.subject, html: payload.html }),
    })
    if (!res.ok) {
      const err = await res.text()
      throw new Error(`Resend error: ${err}`)
    }
    return
  }

  if (provider === 'smtp') {
    // CF Workers does not support raw TCP SMTP. We use an SMTP-to-HTTP gateway (e.g. MailChannels)
    // or remind admins to use Resend. For now, throw a descriptive error.
    throw new Error('Direct SMTP is not supported on CF Workers. Use Resend or configure MailChannels as smtp_host.')
  }

  throw new Error(`Unknown email provider: ${provider}`)
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
