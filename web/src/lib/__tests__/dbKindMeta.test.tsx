import { describe, it, expect, afterEach } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import DbKindMeta from '../../components/DbKindMeta'
import { setLocale } from '../translations'
import type { DbKind } from '../../types'

afterEach(() => setLocale('en'))

const render = (kind?: DbKind, provider?: string | null) =>
  renderToStaticMarkup(<DbKindMeta kind={kind} provider={provider} />)

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

  it('ranks the engine above the provider and the separating dot below both', () => {
    const html = render('postgres')
    expect(html).toContain('text-ink-500')
    expect(html).toContain('text-ink-400')
    expect(html).toContain('text-ink-300')
    expect(html).not.toContain('text-info-600')
    expect(html).not.toContain('text-ink-700')
  })

  it('keeps the provider names in Chinese too', () => {
    setLocale('zh')
    expect(render('mysql')).toContain('TiDB')
    expect(render('sqlite')).toContain('SQLite')
  })

  it("shows the registration's own provider instead of the derived one", () => {
    const html = render('postgres', 'Aiven')
    expect(html).toContain('Aiven')
    expect(html).not.toContain('Neon')
    expect(html).toContain('·')
  })

  it('treats a blank provider text as none at all', () => {
    expect(render('postgres', '   ')).toContain('Neon')
    expect(render('spark', '')).not.toContain('·')
  })

  it('gives a Spark target the provider it was registered with', () => {
    const html = render('spark', 'Instabox')
    expect(html).toContain('SparkSQL')
    expect(html).toContain('Instabox')
  })

  it('leaves the provider step out when the engine has no provider', () => {
    const html = render('spark')
    expect(html).toContain('text-ink-500')
    expect(html).not.toContain('text-ink-400')
    expect(html).not.toContain('text-ink-300')
  })
})
