import { describe, it, expect, afterEach } from 'vitest'
import { errorCodeText } from '../error-copy'
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
})
