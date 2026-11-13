import { describe, it, expect, afterEach } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { DatabaseIdHint } from '../../pages/admin/Databases'
import { t, setLocale } from '../translations'

afterEach(() => setLocale('en'))

describe('DatabaseIdHint', () => {
  it('renders a focusable icon carrying the hint as its accessible name and native title', () => {
    const hint = t('admin_db.cf_database_id_hint')
    const html = renderToStaticMarkup(<DatabaseIdHint text={hint} />)
    expect(html).toMatch(/^<button[^>]*type="button"/)
    expect(html).toContain(`aria-label="${hint}"`)
    expect(html).toContain(`title="${hint}"`)
    // 14px Lucide Info, muted ink
    expect(html).toContain('width="14"')
    expect(html).toContain('height="14"')
    expect(html).toContain('text-ink-400')
    expect(html).not.toContain('disabled')
  })

  it('uses the frozen Chinese sentence and its English counterpart', () => {
    expect(t('admin_db.cf_database_id_hint')).toBe('Only D1 data sources have a database ID — other engines show —')
    setLocale('zh')
    expect(t('admin_db.cf_database_id_hint')).toBe('只有 D1 数据源有数据库 ID，其他引擎显示 —')
    const html = renderToStaticMarkup(<DatabaseIdHint text={t('admin_db.cf_database_id_hint')} />)
    expect(html).toContain('只有 D1 数据源有数据库 ID，其他引擎显示 —')
  })
})
