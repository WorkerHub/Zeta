export type Locale = 'en' | 'zh'

const STORAGE_KEY = 'locale'

export function getStoredLocale(): Locale {
  const stored = localStorage.getItem(STORAGE_KEY)
  if (stored === 'zh' || stored === 'en') return stored
  const browser = navigator.language.toLowerCase()
  if (browser.startsWith('zh')) return 'zh'
  return 'en'
}

export function setStoredLocale(locale: Locale) {
  localStorage.setItem(STORAGE_KEY, locale)
}
