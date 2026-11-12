import { describe, expect, it } from 'vitest'
import { normalizePostgresUrl } from '../pg-url'

// A made-up connection string: the credential is percent-encoded, so the test also covers the
// round trip. No real credential appears anywhere in this file.
const PASS = 'p%40ss'
const base = `postgres://neondb_owner:${PASS}@ep-cool-pooler.eu-central-1.aws.neon.tech/neondb`

describe('normalizePostgresUrl', () => {
  it('strips the parameters Workers cannot honour and forces sslmode=require', () => {
    const r = normalizePostgresUrl(
      `${base}?sslmode=prefer&channel_binding=require&sslrootcert=/etc/ca.pem&sslcert=/c.pem&sslkey=/k.pem`
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.url).toBe(`${base}?sslmode=require`)
    expect(r.host).toBe('ep-cool-pooler.eu-central-1.aws.neon.tech')
    expect(r.database).toBe('neondb')
  })

  it('accepts the postgresql:// scheme and a missing sslmode', () => {
    const r = normalizePostgresUrl('postgresql://u:p@db.example.com:5432/app')
    expect(r.ok && r.url).toBe('postgresql://u:p@db.example.com:5432/app?sslmode=require')
  })

  it('drops parameters that would be sent to the server as startup parameters', () => {
    const r = normalizePostgresUrl(`${base}?pgbouncer=true&schema=public`)
    expect(r.ok && r.url).toBe(`${base}?sslmode=require`)
  })

  it('keeps the parameters the server understands', () => {
    const r = normalizePostgresUrl(`${base}?application_name=zeta&options=-c%20search_path%3Dapp`)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const params = new URL(r.url).searchParams
    expect(params.get('application_name')).toBe('zeta')
    expect(params.get('options')).toBe('-c search_path=app')
    expect(params.get('sslmode')).toBe('require')
  })

  it('decodes the database name for the default display name', () => {
    const r = normalizePostgresUrl('postgres://u:p@h/my%20db')
    expect(r.ok && r.database).toBe('my db')
  })

  it('rejects anything that is not a postgres URL without echoing the input', () => {
    for (const [input, hint] of [
      ['', 'required'],
      ['not a url', 'not a valid'],
      ['mysql://u:p@h/db', 'postgres://'],
      ['postgres:///db', 'missing a host'],
      ['postgres://h/db', 'missing a username'],
    ] as const) {
      const r = normalizePostgresUrl(input)
      expect(r.ok, input).toBe(false)
      expect(!r.ok && r.error, input).toContain(hint)
    }
    // The rejected input (which may hold credentials) is never part of the message.
    const input = 'https://' + 'user:hunter2@example.com/x'
    const r = normalizePostgresUrl(input)
    expect(r.ok).toBe(false)
    expect(!r.ok && r.error).not.toContain('hunter2')
  })

  it('rejects an over-long connection string', () => {
    const r = normalizePostgresUrl(`postgres://u:p@h/${'a'.repeat(5000)}`)
    expect(!r.ok && r.error).toContain('too long')
  })
})
