import { useSyncExternalStore, useCallback } from 'react'
import { getLocale, setLocale, t, subscribeLocale } from '../lib/translations'
import { setStoredLocale } from '../lib/i18n'
import type { Locale } from '../lib/i18n'

export function useLocale() {
  // The server snapshot is the current locale: it lets components that read the locale render in
  // unit tests (vitest renders markup with react-dom/server), and the client never uses it
  const locale = useSyncExternalStore(subscribeLocale, getLocale, getLocale)

  const changeLocale = useCallback((l: Locale) => {
    setStoredLocale(l)
    setLocale(l)
  }, [])

  return { locale, t, changeLocale }
}
