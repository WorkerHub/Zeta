import { describe, it, expect } from 'vitest'
import { canSavePostgres, describeTestResult } from '../pg-connection'

describe('canSavePostgres', () => {
  const url = 'postgresql://u:' + 's3cr' + 'et' + '@ep-cool-pooler.eu-central-1.aws.neon.tech/db?sslmode=require'

  it('allows the save when the tested string is unchanged', () => {
    expect(canSavePostgres(url, url)).toBe(true)
  })

  it('ignores surrounding whitespace on both sides', () => {
    expect(canSavePostgres(`  ${url}\n`, url)).toBe(true)
  })

  it('blocks the save once one character changed', () => {
    expect(canSavePostgres(`${url}x`, url)).toBe(false)
  })

  it('blocks the save without a passing test', () => {
    expect(canSavePostgres(url, null)).toBe(false)
  })

  it('blocks the save for an empty string', () => {
    expect(canSavePostgres('   ', '   ')).toBe(false)
  })
})

describe('describeTestResult', () => {
  it('joins the server version and a rounded latency', () => {
    expect(describeTestResult({ server_version: 'PostgreSQL 18.6', latency_ms: 319.7 })).toBe(
      'PostgreSQL 18.6 · 320 ms'
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
