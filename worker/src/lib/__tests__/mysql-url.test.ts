import { describe, expect, it } from 'vitest'
import { normalizeMySqlUrl } from '../mysql-url'

// A made-up TiDB Cloud Starter connection string: the credential is percent-encoded, so the test
// also covers the round trip. No real credential appears anywhere in this file.
const HOST = 'gateway01.us-east-1.prod.aws.tidbcloud.com'
const PASS = 'p%40ss'
const NO_PORT = `mysql://3Kx9aBcD.root:${PASS}@${HOST}/zeta`
const CANONICAL = `mysql://3Kx9aBcD.root:${PASS}@${HOST}:4000/zeta`

describe('normalizeMySqlUrl', () => {
  it('produces one canonical form: mysql://, port 4000, no parameters, database included', () => {
    const r = normalizeMySqlUrl(`${NO_PORT}?ssl-ca=%2Fetc%2Fca.pem&ssl-mode=VERIFY_IDENTITY&charset=utf8mb4&tls=true`)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.url).toBe(CANONICAL)
    expect(new URL(r.url).search).toBe('')
    expect(r.host).toBe(HOST)
    expect(r.database).toBe('zeta')
  })

  it('accepts the mysql2:// scheme and pins any given port to 4000', () => {
    const r = normalizeMySqlUrl(`mysql2://3Kx9aBcD.root:${PASS}@${HOST}:3306/zeta`)
    expect(r.ok && r.url).toBe(CANONICAL)
  })

  it('defaults an empty database path to `test`', () => {
    const r = normalizeMySqlUrl(`mysql://3Kx9aBcD.root:${PASS}@${HOST}`)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.database).toBe('test')
    expect(r.url).toBe(`mysql://3Kx9aBcD.root:${PASS}@${HOST}:4000/test`)
  })

  it('decodes the database name for the default display name', () => {
    const r = normalizeMySqlUrl(`mysql://u:${PASS}@${HOST}/my%20db`)
    expect(r.ok && r.database).toBe('my db')
    expect(r.ok && r.url).toBe(`mysql://u:${PASS}@${HOST}:4000/my%20db`)
  })

  it('refuses every host that is not a TiDB Cloud gateway', () => {
    for (const host of [
      'localhost',
      '10.0.0.5',
      'db.example.com',
      'mysql.example.com:4000',
      'tidbcloud.com.evil.example.com',
      'evil-tidbcloud.com',
    ]) {
      const r = normalizeMySqlUrl(`mysql://u:${PASS}@${host}/db`)
      expect(r.ok, host).toBe(false)
      expect(!r.ok && r.error, host).toContain('TiDB Cloud Starter')
    }
  })

  it('rejects anything that is not a mysql URL without echoing the input', () => {
    for (const [input, hint] of [
      ['', 'required'],
      ['not a url', 'not a valid'],
      ['postgres://u:p@h/db', 'mysql://'],
      [`mysql://:${PASS}@${HOST}/db`, 'missing a username'],
      [`mysql://3Kx9aBcD.root@${HOST}/db`, 'missing a password'],
      ['mysql:///db', 'missing a host'],
    ] as const) {
      const r = normalizeMySqlUrl(input)
      expect(r.ok, input).toBe(false)
      expect(!r.ok && r.error, input).toContain(hint)
    }
    // The rejected input (which may hold credentials) is never part of the message.
    const input = `https://3Kx9aBcD.root:hunter2@${HOST}/db`
    const r = normalizeMySqlUrl(input)
    expect(r.ok).toBe(false)
    expect(!r.ok && r.error).not.toContain('hunter2')
  })

  it('points at percent-encoding when the credential holds an unencoded @', () => {
    const r = normalizeMySqlUrl(`mysql://3Kx9aBcD.root:pa@ss@${HOST}/db`)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toContain('percent-encode')
    expect(r.error).not.toContain('pa@ss')
  })

  it('rejects an invalid percent-encoding in the credentials instead of failing at connect time', () => {
    const r = normalizeMySqlUrl(`mysql://3Kx9aBcD.root:pa%zz@${HOST}/db`)
    expect(r.ok).toBe(false)
    expect(!r.ok && r.error).toContain('%25')
  })

  it('rejects an over-long connection string', () => {
    const r = normalizeMySqlUrl(`mysql://u:${PASS}@${HOST}/${'a'.repeat(5000)}`)
    expect(!r.ok && r.error).toContain('too long')
  })
})
