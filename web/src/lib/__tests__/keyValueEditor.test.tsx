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

  it('matches a server error keyed by the trimmed key against a padded row', () => {
    // The dialog trims before sending, so the server answers with the trimmed key while the row's
    // input may still carry surrounding whitespace.
    const html = render([{ key: '  spark.sql.nope  ', value: '1' }], {
      serverErrors: { 'spark.sql.nope': 'server said no' },
    })
    expect(html).toContain('server said no')
  })

  it('renders the injected validator message per row', () => {
    const html = render(
      [
        { key: 'a', value: '1' },
        { key: 'a', value: '2' },
      ],
      {
        validate: (row, all) =>
          row.key && all.filter((r) => r.key.trim() === row.key.trim()).length > 1 ? 'duplicate' : null,
      }
    )
    expect(html.match(/duplicate/g)).toHaveLength(2)
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
