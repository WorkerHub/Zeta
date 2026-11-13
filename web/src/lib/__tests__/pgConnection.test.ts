import { describe, it, expect } from 'vitest'
import { canSaveConnectionString, describeTestResult } from '../pg-connection'

describe('canSaveConnectionString', () => {
  const url = 'postgresql://u:' + 's3cr' + 'et' + '@ep-cool-pooler.eu-central-1.aws.neon.tech/db?sslmode=require'
  const mysqlUrl = 'mysql://u:' + 's3cr' + 'et' + '@gateway01.us-east-1.prod.aws.tidbcloud.com:4000/test'

  it('allows the save when the tested string is unchanged', () => {
    expect(canSaveConnectionString(url, url)).toBe(true)
  })

  it('gates a MySQL string the same way', () => {
    expect(canSaveConnectionString(mysqlUrl, mysqlUrl)).toBe(true)
    expect(canSaveConnectionString(mysqlUrl, url)).toBe(false)
  })

  it('ignores surrounding whitespace on both sides', () => {
    expect(canSaveConnectionString(`  ${url}\n`, url)).toBe(true)
  })

  it('blocks the save once one character changed', () => {
    expect(canSaveConnectionString(`${url}x`, url)).toBe(false)
  })

  it('blocks the save without a passing test', () => {
    expect(canSaveConnectionString(url, null)).toBe(false)
  })

  it('blocks the save for an empty string', () => {
    expect(canSaveConnectionString('   ', '   ')).toBe(false)
  })
})

describe('describeTestResult', () => {
  it('joins the server version and a rounded latency', () => {
    expect(describeTestResult({ server_version: 'PostgreSQL 18.6', latency_ms: 319.7 })).toBe(
      'PostgreSQL 18.6 · 320 ms'
    )
  })

  it('shows the TiDB version string a MySQL target reports', () => {
    expect(describeTestResult({ server_version: '8.0.11-TiDB-v8.5.3', latency_ms: 120 })).toBe(
      '8.0.11-TiDB-v8.5.3 · 120 ms'
    )
  })

  it('drops whichever part the response omits', () => {
    expect(describeTestResult({ latency_ms: 12 })).toBe('12 ms')
    expect(describeTestResult({ server_version: 'PostgreSQL 18.6' })).toBe('PostgreSQL 18.6')
    expect(describeTestResult({})).toBe('')
  })

  it('ignores a non-finite latency', () => {
    expect(describeTestResult({ latency_ms: Number.NaN })).toBe('')
  })
})
