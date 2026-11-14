import { afterEach, describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import KeyValueEditor from '../../components/KeyValueEditor'
import { setLocale, t } from '../translations'
import type { ProfileEntry } from '../../types'

afterEach(() => setLocale('en'))

const noop = () => {}

const render = (rows: ProfileEntry[], props: Partial<Parameters<typeof KeyValueEditor>[0]> = {}) =>
  renderToStaticMarkup(<KeyValueEditor rows={rows} onChange={noop} {...props} />)

describe('KeyValueEditor', () => {
  it('renders one key/value input pair per row with the = separator', () => {
    const html = render([{ key: 'spark.sql.foo', value: '1' }])
    expect(html).toContain('value="spark.sql.foo"')
    expect(html).toContain('value="1"')
    expect(html).toContain('>=') // the separator
    expect(html).toContain(t('spark.add_row'))
  })

  it('shows a server-returned error against the offending key', () => {
    const html = render([{ key: 'spark.sql.extensions', value: 'x' }], {
      serverErrors: { 'spark.sql.extensions': '参数为启动级参数' },
    })
    expect(html).toContain('参数为启动级参数')
  })

  it('keeps at least one row by disabling the delete button on a single row', () => {
    const html = render([{ key: '', value: '' }])
    // The only delete button is disabled when there is one row.
    expect(html).toContain('disabled')
  })

  it('renders the injected placeholders', () => {
    const html = render([{ key: '', value: '' }], {
      placeholders: { key: 'spark.sql.shuffle.partitions', value: '200' },
    })
    expect(html).toContain('placeholder="spark.sql.shuffle.partitions"')
    expect(html).toContain('placeholder="200"')
  })
})
