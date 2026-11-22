// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { render as rtlRender, screen, fireEvent, cleanup } from '@testing-library/react'
import StickySaveBar from '../../components/StickySaveBar'
import { setLocale, t } from '../translations'

afterEach(() => {
  cleanup()
  setLocale('en')
})

const noop = () => {}

function renderStatic(props: Partial<Parameters<typeof StickySaveBar>[0]> = {}) {
  return renderToStaticMarkup(<StickySaveBar dirty={false} saving={false} saved={false} onSave={noop} {...props} />)
}

describe('StickySaveBar', () => {
  it('disables save button and shows all saved status when there are no changes (clean)', () => {
    const html = renderStatic({ dirty: false, saving: false })
    expect(html).toContain('disabled')
    expect(html).toContain(t('admin_settings.all_saved'))
    expect(html).toContain(t('admin_settings.save_changes'))
    expect(html).not.toContain('animate-spin')
  })

  it('enables save button and shows unsaved changes status when there are changes (dirty)', () => {
    const html = renderStatic({ dirty: true, saving: false })
    // Button is not disabled
    expect(html).not.toMatch(/<button[^>]*disabled/)
    expect(html).toContain(t('admin_settings.unsaved_changes'))
    expect(html).toContain('bg-brand-600')
  })

  it('disables save button and shows saving indicator while saving', () => {
    const html = renderStatic({ dirty: true, saving: true })
    expect(html).toContain('disabled')
    expect(html).toContain('animate-spin')
    expect(html).toContain(t('auth.saving'))
  })

  it('shows success status after save succeeds', () => {
    const html = renderStatic({ dirty: false, saving: false, saved: true })
    expect(html).toContain('disabled')
    expect(html).toContain(t('admin_settings.saved'))
    expect(html).toContain('text-success-600')
  })

  it('renders error alert when error is present', () => {
    const html = renderStatic({ dirty: true, error: 'Database network timeout' })
    expect(html).toContain('role="alert"')
    expect(html).toContain('Database network timeout')
    expect(html).toContain('text-danger-600')
  })

  it('contains sticky bar and bottom safe area positioning classes with localized aria-label', () => {
    const html = renderStatic()
    expect(html).toContain('sticky bottom-0')
    expect(html).toContain('z-(--z-sticky-bar)')
    expect(html).toContain('safe-b')
    expect(html).toContain(`aria-label="${t('admin_settings.save_bar')}"`)
  })

  it('supports custom aria-label', () => {
    const html = renderStatic({ ariaLabel: 'Custom save controls' })
    expect(html).toContain('aria-label="Custom save controls"')
  })

  it('supports Chinese locale labels', () => {
    setLocale('zh')
    const htmlClean = renderStatic({ dirty: false })
    expect(htmlClean).toContain('已保存')
    expect(htmlClean).toContain('保存更改')

    const htmlDirty = renderStatic({ dirty: true })
    expect(htmlDirty).toContain('有未保存更改')

    const htmlSaving = renderStatic({ dirty: true, saving: true })
    expect(htmlSaving).toContain('保存中…')

    const htmlSaved = renderStatic({ saved: true })
    expect(htmlSaved).toContain('已保存！')
  })

  it('fires onSave callback when enabled button is clicked', () => {
    const onSave = vi.fn()
    rtlRender(<StickySaveBar dirty={true} saving={false} saved={false} onSave={onSave} />)
    const button = screen.getByRole('button', { name: t('admin_settings.save_changes') }) as HTMLButtonElement
    expect(button.disabled).toBe(false)
    fireEvent.click(button)
    expect(onSave).toHaveBeenCalledTimes(1)
  })

  it('prevents onSave callback when button is disabled', () => {
    const onSave = vi.fn()
    rtlRender(<StickySaveBar dirty={false} saving={false} saved={false} onSave={onSave} />)
    const button = screen.getByRole('button', { name: t('admin_settings.save_changes') }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
    fireEvent.click(button)
    expect(onSave).not.toHaveBeenCalled()
  })
})
