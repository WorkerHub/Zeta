import { useEffect, useState } from 'react'

export type Theme = 'auto' | 'light' | 'dark'

const STORAGE_KEY = 'theme'
const CYCLE: Theme[] = ['auto', 'light', 'dark']

function applyTheme(theme: Theme) {
  const html = document.documentElement
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches
  const isDark = theme === 'dark' || (theme === 'auto' && prefersDark)
  if (isDark) {
    html.classList.add('dark')
  } else {
    html.classList.remove('dark')
  }
  const metaTheme = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')
  if (metaTheme) metaTheme.content = isDark ? '#09090b' : '#fafafa'
}

export function useTheme() {
  const [theme, setTheme] = useState<Theme>(
    () => (localStorage.getItem(STORAGE_KEY) as Theme | null) ?? 'auto'
  )

  useEffect(() => {
    applyTheme(theme)
    localStorage.setItem(STORAGE_KEY, theme)

    if (theme !== 'auto') return
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const handler = () => applyTheme('auto')
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [theme])

  function cycleTheme() {
    setTheme((prev) => {
      const idx = CYCLE.indexOf(prev)
      return CYCLE[(idx + 1) % CYCLE.length] as Theme
    })
  }

  return { theme, cycleTheme }
}
