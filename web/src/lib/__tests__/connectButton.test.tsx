import { describe, it, expect, afterEach } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import ConnectButton from '../../components/ConnectButton'
import { setLocale, t } from '../translations'

afterEach(() => setLocale('en'))

const noop = () => {}

const render = (props: Partial<Parameters<typeof ConnectButton>[0]> = {}) =>
  renderToStaticMarkup(<ConnectButton connected={false} busy={false} onConnect={noop} onDisconnect={noop} {...props} />)

describe('ConnectButton', () => {
  it('offers the connection as the page action while disconnected', () => {
    const html = render()
    expect(html).toContain('btn-primary')
    expect(html).toContain('aria-pressed="false"')
    expect(html).toContain(t('query.connect'))
    expect(html).not.toContain(t('query.connected'))
    expect(html).not.toContain('animate-spin')
  })

  it('shows the connected state and offers to disconnect on hover', () => {
    const html = render({ connected: true })
    expect(html).toContain('btn-secondary')
    expect(html).toContain('aria-pressed="true"')
    expect(html).toContain(t('query.connected'))
    expect(html).toContain(t('query.disconnect'))
    // The hover/focus swap is CSS-only: no state, no second button
    expect(html).toContain('group-hover:')
    expect(html).toContain('group-focus-visible:')
  })

  it('is disabled and spinning while the probe runs', () => {
    const html = render({ busy: true })
    expect(html).toContain('disabled')
    expect(html).toContain('aria-busy="true"')
    expect(html).toContain('animate-spin')
    expect(html).not.toContain('aria-pressed')
  })

  it('carries the Chinese labels too', () => {
    setLocale('zh')
    expect(t('query.connect')).toBe('连接')
    expect(render({ connected: true })).toContain('已连接')
    expect(render({ connected: true })).toContain('取消连接')
  })
})
