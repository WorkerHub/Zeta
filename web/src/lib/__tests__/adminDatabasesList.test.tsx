import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it } from 'vitest'
import { COL_ENGINE, COL_ID, COL_NAME, COL_PROVIDER, COL_STATUS, DatabaseIdText } from '../../pages/admin/Databases'
import { setLocale, t } from '../translations'

afterEach(() => setLocale('en'))

// §4 froze the desktop list: every column is a hard width fed to a <colgroup> under `table-fixed`,
// with only the action column left to size itself from its buttons.
const source = import.meta.glob<string>('../../pages/admin/Databases.tsx', {
  query: '?raw',
  import: 'default',
  eager: true,
})['../../pages/admin/Databases.tsx']!

describe('data-source list columns', () => {
  it('keeps the §4 widths', () => {
    expect(COL_NAME).toBe('md:w-[200px]')
    expect(COL_ENGINE).toBe('md:w-[140px]')
    expect(COL_PROVIDER).toBe('md:w-[120px]')
    expect(COL_ID).toBe('md:w-[300px]')
    expect(COL_STATUS).toBe('md:w-[112px]')
  })

  it('makes them hard constraints instead of preferred widths', () => {
    expect(source).toContain('<colgroup>')
    expect(source).toContain('className="w-full text-body md:w-max md:table-fixed"')
  })

  it('leaves the action buttons hugging the status column, not the card edge', () => {
    expect(source).toContain('<div className="flex items-center gap-1">')
  })
})

describe('DatabaseIdText', () => {
  const uuid = '3f2b8c4e-1a2b-4c5d-8e9f-0a1b2c3d4e5f'

  it('renders the whole ID as plain monospaced text with the ID in its title', () => {
    const html = renderToStaticMarkup(<DatabaseIdText value={uuid} />)
    expect(html).toMatch(/^<code[^>]*>/)
    expect(html).toContain(uuid)
    expect(html).toContain(`title="${uuid}"`)
    expect(html).toContain('font-mono')
    expect(html).toContain('text-ink-700')
    expect(html).toContain('truncate')
  })

  it('paints no background, rounding or padding of its own', () => {
    const html = renderToStaticMarkup(<DatabaseIdText value={uuid} />)
    expect(html).not.toMatch(/\bbg-/)
    expect(html).not.toContain('rounded')
    expect(html).not.toMatch(/\b[pm]x-/)
    expect(html).not.toMatch(/\b[pm]y-/)
  })
})

describe('app database badge', () => {
  it('is called “应用库” in Chinese and “App DB” in English', () => {
    setLocale('zh')
    expect(t('admin_db.app_db_badge')).toBe('应用库')
    setLocale('en')
    expect(t('admin_db.app_db_badge')).toBe('App DB')
  })
})
