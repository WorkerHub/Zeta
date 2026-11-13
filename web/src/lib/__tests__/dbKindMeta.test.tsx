import { describe, it, expect, afterEach } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import DbKindMeta from '../../components/DbKindMeta'
import { setLocale } from '../translations'
import type { DbKind } from '../../types'

afterEach(() => setLocale('en'))

const render = (kind?: DbKind) => renderToStaticMarkup(<DbKindMeta kind={kind} />)

describe('DbKindMeta', () => {
  it('names the engine and the provider it runs on', () => {
    expect(render('sqlite')).toContain('SQLite')
    expect(render('sqlite')).toContain('D1')
    expect(render('postgres')).toContain('PostgreSQL')
    expect(render('postgres')).toContain('Neon')
    expect(render('mysql')).toContain('MySQL')
    expect(render('mysql')).toContain('TiDB')
  })

  it('leaves the separator and the provider out for an engine that has none', () => {
    const html = render('spark')
    expect(html).toContain('SparkSQL')
    expect(html).not.toContain('·')
  })

  it('treats a registration from before the kind column as D1', () => {
    expect(render(undefined)).toContain('SQLite')
    expect(render(undefined)).toContain('D1')
  })

  it('renders the engine in the info accent and the provider in the plain text colour', () => {
    const html = render('postgres')
    expect(html).toContain('text-info-600')
    expect(html).toContain('text-ink-700')
  })

  it('keeps the provider names in Chinese too', () => {
    setLocale('zh')
    expect(render('mysql')).toContain('TiDB')
    expect(render('sqlite')).toContain('SQLite')
  })
})
