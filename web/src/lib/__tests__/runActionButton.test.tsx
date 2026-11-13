import { describe, it, expect, afterEach } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import RunActionButton from '../../components/RunActionButton'
import { setLocale, t } from '../translations'

afterEach(() => setLocale('en'))

const noop = () => {}

const render = (props: Partial<Parameters<typeof RunActionButton>[0]> = {}) =>
  renderToStaticMarkup(
    <RunActionButton
      label="Run"
      running={false}
      cancelling={false}
      enabled
      onClick={noop}
      className="btn-primary btn-sm gap-1.5 hidden sm:flex"
      iconSize={13}
      {...props}
    />
  )

describe('RunActionButton', () => {
  it('starts the run when it is idle', () => {
    const html = render()
    expect(html).toContain(t('query.run'))
    expect(html).not.toContain('animate-spin')
    expect(html).not.toContain('disabled')
    expect(html).not.toContain('aria-busy')
    expect(html).not.toContain(t('query.cancel_run'))
  })

  it('is disabled while no connected target can be run', () => {
    const html = render({ enabled: false, title: t('query.connect_first') })
    expect(html).toContain('disabled')
    expect(html).toContain(`title="${t('query.connect_first')}"`)
  })

  it('turns into the cancel button while a run is in flight, staying clickable', () => {
    const html = render({ running: true })
    // Spinning, clickable (no disabled), and saying what a click does on hover
    expect(html).toContain('animate-spin')
    expect(html).toContain('aria-busy="true"')
    expect(html).not.toContain('disabled')
    expect(html).toContain(`title="${t('query.cancel_run')}"`)
    // The label itself stays the run's own: the spinner and the tooltip carry the state
    expect(html).toContain('>Run<')
    expect(html).not.toContain(t('query.cancelling'))
  })

  it('says so once the cancel signal is on its way', () => {
    const html = render({ running: true, cancelling: true })
    expect(html).toContain(t('query.cancelling'))
    expect(html).toContain(`title="${t('query.cancelling')}"`)
    expect(html).toContain('animate-spin')
    // Still clickable: the handler ignores the repeat, not the button
    expect(html).not.toContain('disabled')
  })

  it('carries the Chinese wording too', () => {
    setLocale('zh')
    expect(render({ running: true })).toContain('取消执行')
    expect(render({ running: true, cancelling: true })).toContain('正在取消…')
  })
})
