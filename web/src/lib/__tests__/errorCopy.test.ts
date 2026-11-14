import { describe, it, expect, afterEach } from 'vitest'
import { errorCodeText, sparkErrorKind } from '../error-copy'
import { setLocale, t } from '../translations'

afterEach(() => setLocale('en'))

describe('errorCodeText', () => {
  it('gives the copy for a known Spark code, in the current locale', () => {
    expect(errorCodeText(t, { error: 'the worker sentence', code: 'spark_stopped' })).toBe(
      t('spark_error.spark_stopped')
    )
    setLocale('zh')
    expect(errorCodeText(t, { error: 'the worker sentence', code: 'spark_publish_token' })).toBe(
      '发布地址的访问令牌被拒，请管理员重新发布并更新登记信息。'
    )
  })

  it('returns null without a code, so the worker message is shown as it arrived', () => {
    expect(errorCodeText(t, { error: 'boom' })).toBeNull()
    expect(errorCodeText(t, null)).toBeNull()
    expect(errorCodeText(t, undefined)).toBeNull()
    expect(errorCodeText(t, 'plain text')).toBeNull()
  })

  it('returns null for a code it does not know', () => {
    expect(errorCodeText(t, { code: 'mysql_something' })).toBeNull()
    // Prototype keys are not codes
    expect(errorCodeText(t, { code: 'toString' })).toBeNull()
  })

  it('names the rejected key for a profile code', () => {
    const startup = errorCodeText(t, { error: 'x', code: 'startup_key_in_profile', key: 'spark.sql.extensions' })
    expect(startup).toContain('spark.sql.extensions')
    expect(startup).toBe(t('spark_error.startup_key_in_profile', { key: 'spark.sql.extensions' }))
    const invalid = errorCodeText(t, { error: 'x', code: 'invalid_key', key: 'spark.foo' })
    expect(invalid).toContain('spark.foo')
  })

  it('fills the in-flight count for a draining environment', () => {
    const text = errorCodeText(t, { error: 'x', code: 'context_draining', inflight: 3 })
    expect(text).toBe(t('spark_error.context_draining', { n: 3 }))
    expect(text).toContain('3')
  })

  it('covers every Spark error code in both locales', () => {
    const codes = [
      'spark_stopped',
      'spark_not_ready',
      'spark_app_token',
      'spark_publish_token',
      'startup_key_in_profile',
      'invalid_key',
      'context_draining',
      'context_restarting',
      'context_rebuilt',
    ]
    for (const code of codes) {
      expect(errorCodeText(t, { code })).toBeTruthy()
      setLocale('zh')
      expect(errorCodeText(t, { code })).toBeTruthy()
      setLocale('en')
    }
  })
})

describe('sparkErrorKind', () => {
  it('classes engine, profile and context codes, and null for everything else', () => {
    expect(sparkErrorKind('spark_stopped')).toBe('engine')
    expect(sparkErrorKind('startup_key_in_profile')).toBe('profile')
    expect(sparkErrorKind('invalid_key')).toBe('profile')
    expect(sparkErrorKind('context_draining')).toBe('context')
    expect(sparkErrorKind('context_restarting')).toBe('context')
    expect(sparkErrorKind('context_rebuilt')).toBe('context')
    expect(sparkErrorKind('mysql_something')).toBeNull()
    expect(sparkErrorKind(undefined)).toBeNull()
    expect(sparkErrorKind(null)).toBeNull()
  })
})
