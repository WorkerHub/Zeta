import { describe, it, expect, afterEach } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { COL_WIDTH, DatabaseIdCell, cellClass, TABLE_MIN_WIDTH } from '../../pages/admin/Databases'
import { setLocale, t } from '../translations'
import type { AdminDatabase } from '../../types'

afterEach(() => setLocale('en'))

const row = (over: Partial<AdminDatabase> = {}): AdminDatabase => ({
  id: 'row-1',
  name: 'Analytics warehouse',
  description: null,
  kind: 'sqlite',
  provider: null,
  provider_custom: null,
  binding_name: 'analytics',
  cf_database_id: '3f1a9c47-8d22-4ee0-9b6a-51c0d70f2b18',
  is_active: 1,
  created_at: 1_760_000_000,
  is_app_db: false,
  ...over,
})

const render = (db: AdminDatabase) => renderToStaticMarkup(<DatabaseIdCell db={db} />)

const widthPx = (col: keyof typeof COL_WIDTH): number => {
  const m = /\[(\d+)px\]/.exec(COL_WIDTH[col])
  return m ? Number(m[1]) : 0
}

describe('data-source list columns', () => {
  it('locks every pinned column at the agreed width and leaves the name column flexible', () => {
    // Engine 140 / provider 120 / database ID 300 / status 112 — the #28 values, unchanged
    expect(widthPx('engine')).toBe(140)
    expect(widthPx('provider')).toBe(120)
    expect(widthPx('databaseId')).toBe(300)
    expect(widthPx('status')).toBe(112)
    // 268px of content after the 32px padding: a 36-character UUID needs ~252px
    expect(widthPx('databaseId') - 32).toBeGreaterThanOrEqual(252)
    expect(widthPx('databaseId')).toBeLessThanOrEqual(320)
    // The name column carries no width: it absorbs the card's remaining width on desktop
    expect(COL_WIDTH.name).toBe('')
    expect(widthPx('name')).toBe(0)
  })

  it('pins the actions column at its measured width and keeps the padding off the width', () => {
    // The widest action row — English labels plus a legacy row's Link button — measures 331.7px
    expect(COL_WIDTH.actions).toBe('md:w-[332px]')
    expect(widthPx('actions')).toBe(332)
    // The column width now lives on the <col>, so the cell carries only its padding
    expect(cellClass()).toBe('px-4 py-3')
    expect(cellClass('whitespace-nowrap')).toBe('px-4 py-3 whitespace-nowrap')
    // Every pinned column is a hard width at `md` and up only: below that the table keeps its natural columns
    for (const col of ['engine', 'provider', 'databaseId', 'status', 'actions'] as const) {
      expect(COL_WIDTH[col].startsWith('md:w-')).toBe(true)
    }
    // The table's desktop minimum holds the name column's 200px floor plus the pinned widths, so at
    // narrow widths the table scrolls instead of squeezing the name column to nothing
    expect(TABLE_MIN_WIDTH).toBe('md:min-w-[1204px]')
  })
})

describe('DatabaseIdCell', () => {
  it('shows the UUID as plain monospaced text, without a tinted block behind it', () => {
    const db = row()
    const html = render(db)
    expect(html).toContain(db.cf_database_id!)
    expect(html).toContain(`title="${db.cf_database_id}"`)
    expect(html).toContain('font-mono')
    expect(html).toContain('text-ink-700')
    expect(html).toContain('truncate')
    // No background, no rounding, no inner padding: the coloured bar filled the column's slack
    expect(html).not.toContain('bg-')
    expect(html).not.toContain('rounded')
    expect(html).not.toContain('px-')
    expect(html).not.toContain('py-')
  })

  it('shows a dash for engines that have no database ID', () => {
    expect(render(row({ kind: 'postgres', cf_database_id: null }))).toBe(
      '<span class="text-caption text-ink-400">—</span>'
    )
    // A row written before the kind column existed is a D1 registration, so it keeps its ID
    expect(render(row({ kind: undefined }))).toContain(row().cf_database_id!)
  })

  it('keeps the binding badge for a registration that is not linked yet', () => {
    const html = render(row({ cf_database_id: null, binding_name: 'legacy_db' }))
    expect(html).toContain('badge-neutral')
    expect(html).toContain('legacy_db')
    expect(html).toContain(t('admin_db.legacy_binding', { name: 'legacy_db' }))
  })
})

describe('application database badge', () => {
  it('is short in both locales, from the one shared key', () => {
    expect(t('admin_db.app_db_badge')).toBe('App DB')
    setLocale('zh')
    expect(t('admin_db.app_db_badge')).toBe('应用库')
  })
})
