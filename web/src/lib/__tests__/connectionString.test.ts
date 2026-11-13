import { describe, it, expect } from 'vitest'
import { canSaveConnection, connectionSignature, describeTestResult } from '../connection-string'

const pg = 'postgresql://u:' + 's3cr' + 'et' + '@ep-cool-pooler.eu-central-1.aws.neon.tech/db?sslmode=require'
const my = 'mysql://u:' + 's3cr' + 'et' + '@gateway01.us-east-1.prod.aws.tidbcloud.com:4000/test'
const spark = { url: 'https://spark.example.com', platformToken: 'platform-token', appToken: 'app-token' }

describe('connectionSignature', () => {
  it('covers the engine and the value pasted into it', () => {
    expect(connectionSignature({ kind: 'postgres', url: pg })).toBe(
      connectionSignature({ kind: 'postgres', url: `  ${pg}\n` })
    )
    expect(connectionSignature({ kind: 'postgres', url: pg })).not.toBe(connectionSignature({ kind: 'mysql', url: pg }))
    expect(connectionSignature({ kind: 'mysql', url: my })).not.toBe(connectionSignature({ kind: 'mysql', url: pg }))
  })

  it('needs all three Spark values', () => {
    expect(connectionSignature({ kind: 'spark', ...spark })).not.toBeNull()
    expect(connectionSignature({ kind: 'spark', url: spark.url, appToken: spark.appToken })).toBeNull()
    expect(connectionSignature({ kind: 'spark', ...spark, url: '' })).toBeNull()
    expect(connectionSignature({ kind: 'spark', ...spark, platformToken: '   ' })).toBeNull()
  })

  it('changes when either Spark token changes', () => {
    const tested = connectionSignature({ kind: 'spark', ...spark })
    expect(connectionSignature({ kind: 'spark', ...spark, appToken: 'other' })).not.toBe(tested)
    expect(connectionSignature({ kind: 'spark', ...spark, platformToken: 'other' })).not.toBe(tested)
  })
})

describe('canSaveConnection', () => {
  const tested = connectionSignature({ kind: 'postgres', url: pg })

  it('allows the save when the form still holds the tested values', () => {
    expect(canSaveConnection(tested, tested)).toBe(true)
  })

  it('blocks the save once one character changed or nothing was tested', () => {
    expect(canSaveConnection(connectionSignature({ kind: 'postgres', url: `${pg}x` }), tested)).toBe(false)
    expect(canSaveConnection(tested, null)).toBe(false)
  })

  it('does not let one engine vouch for another', () => {
    expect(canSaveConnection(connectionSignature({ kind: 'mysql', url: my }), tested)).toBe(false)
  })

  it('blocks the save while a required value is missing', () => {
    const incomplete = connectionSignature({ kind: 'spark', url: spark.url, platformToken: 'p' })
    expect(canSaveConnection(incomplete, incomplete)).toBe(false)
    expect(canSaveConnection(null, null)).toBe(false)
  })
})

describe('describeTestResult', () => {
  it('joins the server version and a rounded latency', () => {
    expect(describeTestResult({ server_version: 'PostgreSQL 18.6', latency_ms: 319.7 })).toBe(
      'PostgreSQL 18.6 · 320 ms'
    )
    expect(describeTestResult({ server_version: '8.0.11-TiDB-v8.5.3', latency_ms: 210 })).toBe(
      '8.0.11-TiDB-v8.5.3 · 210 ms'
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
