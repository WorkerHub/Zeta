import type { Locale } from './i18n'

// Short relative time ("5m ago" / "5分钟前") for a Unix timestamp in seconds
export function timeAgo(ts: number, locale: Locale): string {
  const diff = Math.floor(Date.now() / 1000) - ts
  if (locale === 'zh') {
    if (diff < 60) return '刚刚'
    if (diff < 3600) return `${Math.floor(diff / 60)}分钟前`
    if (diff < 86400) return `${Math.floor(diff / 3600)}小时前`
    return `${Math.floor(diff / 86400)}天前`
  }
  if (diff < 60) return 'just now'
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
  return `${Math.floor(diff / 86400)}d ago`
}
