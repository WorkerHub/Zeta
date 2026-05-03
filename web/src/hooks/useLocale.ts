import { useSyncExternalStore, useCallback } from 'react'
import { getLocale, setLocale, t, subscribeLocale } from '../lib/translations'
import { getStoredLocale, setStoredLocale } from '../lib/i18n'
import type { Locale } from '../lib/i18n'

export function useLocale() {
  const locale = useSyncExternalStore(subscribeLocale, getLocale)

  const changeLocale = useCallback((l: Locale) => {
    setStoredLocale(l)
    setLocale(l)
  }, [])

  return { locale, t, changeLocale }
}
