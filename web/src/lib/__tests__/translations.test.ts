import { describe, it, expect, afterEach } from 'vitest'
import { translations, t, setLocale } from '../translations'

// Raw source of every component/page, to check the keys they pass to t()
const sources = import.meta.glob<string>('../../**/*.tsx', { query: '?raw', import: 'default', eager: true })

afterEach(() => setLocale('en'))

describe('translations', () => {
  it('has a Chinese text for every English key and vice versa', () => {
    expect(Object.keys(translations.zh).sort()).toEqual(Object.keys(translations.en).sort())
  })

  it('defines every literal key used in the UI', () => {
    const used = new Set<string>()
    for (const src of Object.values(sources)) {
      for (const m of src.matchAll(/\bt\(\s*'([\w.]+)'/g)) used.add(m[1]!)
    }
    expect(used.size).toBeGreaterThan(50)
    expect([...used].filter((key) => !(key in translations.en))).toEqual([])
  })

  it('fills {placeholders}', () => {
    expect(t('results.rows', { n: 3 })).toBe('3 rows')
    setLocale('zh')
    expect(t('results.count', { n: 2 })).toBe('2 个结果')
  })

  it('leaves unknown placeholders and plain keys alone', () => {
    expect(t('admin_db.confirm_delete', { other: 'x' })).toContain('{name}')
    expect(t('no.such.key')).toBe('no.such.key')
  })
})
