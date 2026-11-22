// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import AdminSettings from '../../pages/admin/AdminSettings'
import { adminApi } from '../api'
import { setLocale, t } from '../translations'

vi.mock('../api', () => ({
  adminApi: {
    getSettings: vi.fn(),
    updateSettings: vi.fn(),
    testEmail: vi.fn(),
  },
  adminSetupApi: {
    run: vi.fn(),
  },
  ApiError: class ApiError extends Error {
    status: number
    constructor(status: number, message: string) {
      super(message)
      this.status = status
    }
  },
}))

afterEach(() => {
  cleanup()
  setLocale('en')
  vi.clearAllMocks()
})

const defaultMockSettings = {
  app_name: 'Zeta',
  registration_enabled: 'false',
  require_email_verification: 'true',
  enforce_2fa: 'false',
  setup_page_enabled: '1',
  notebook_run_limit: '100',
  run_storage_quota_mb: '50',
  email_provider: 'none',
}

describe('AdminSettings sticky save bar integration', () => {
  beforeEach(() => {
    vi.mocked(adminApi.getSettings).mockResolvedValue({ ...defaultMockSettings })
    vi.mocked(adminApi.updateSettings).mockResolvedValue(undefined as never)
  })

  it('removes top save button: only exactly one save button exists on the page (in sticky bar)', async () => {
    render(<AdminSettings />)

    await waitFor(() => {
      expect(screen.queryByText('Loading…')).toBeNull()
    })

    // Header has the title
    expect(screen.getByRole('heading', { level: 1, name: 'Settings' })).toBeDefined()

    // Exactly one save button exists across the whole page (in the sticky save bar)
    const saveButtons = screen.getAllByRole('button', { name: /Save changes/i })
    expect(saveButtons).toHaveLength(1)

    // Save bar is at the bottom with sticky styling and localized aria-label
    const saveBarRegion = screen.getByRole('region', { name: t('admin_settings.save_bar') })
    expect(saveBarRegion.className).toContain('sticky bottom-0')
    expect(saveBarRegion.className).toContain('z-(--z-sticky-bar)')
  })

  it('content area has clearance padding ensuring the bottom-most item is fully visible above bar', async () => {
    const { container } = render(<AdminSettings />)

    await waitFor(() => {
      expect(screen.queryByText('Loading…')).toBeNull()
    })

    const contentArea = container.querySelector('.max-w-5xl.w-full.mx-auto')
    expect(contentArea).not.toBeNull()
    expect(contentArea?.className).toContain('pb-20')
  })

  it('follows the status rules: disabled when clean -> enabled on edit -> saving disabled -> saved disabled', async () => {
    let resolveUpdate: () => void
    const updatePromise = new Promise<void>((resolve) => {
      resolveUpdate = resolve
    })
    vi.mocked(adminApi.updateSettings).mockImplementation(() => updatePromise as never)

    render(<AdminSettings />)

    await waitFor(() => {
      expect(screen.queryByText('Loading…')).toBeNull()
    })

    const saveButton = screen.getByRole('button', { name: 'Save changes' }) as HTMLButtonElement

    // 1. Clean: save is disabled, status says "Saved"
    expect(saveButton.disabled).toBe(true)
    expect(screen.getByText('Saved')).toBeDefined()

    // 2. Edit a field: save becomes enabled, status says "Unsaved changes"
    const appNameInput = screen.getByLabelText('App name')
    fireEvent.change(appNameInput, { target: { value: 'Zeta Enterprise' } })

    expect(saveButton.disabled).toBe(false)
    expect(screen.getByText('Unsaved changes')).toBeDefined()

    // 3. Click save: enters saving state, button disabled to prevent duplicate submissions
    fireEvent.click(saveButton)
    expect(saveButton.disabled).toBe(true)
    expect(screen.getByText('Saving…')).toBeDefined()

    // 4. Update completes: returns to saved state, button disabled
    resolveUpdate!()
    await waitFor(() => {
      expect(screen.getByText('Saved!')).toBeDefined()
    })
    expect(saveButton.disabled).toBe(true)
  })

  it('displays save errors directly in the save bar', async () => {
    vi.mocked(adminApi.updateSettings).mockRejectedValueOnce(new Error('Network error: 504 Gateway Timeout'))

    render(<AdminSettings />)

    await waitFor(() => {
      expect(screen.queryByText('Loading…')).toBeNull()
    })

    const appNameInput = screen.getByLabelText('App name')
    fireEvent.change(appNameInput, { target: { value: 'Zeta New' } })

    const saveButton = screen.getByRole('button', { name: 'Save changes' })
    fireEvent.click(saveButton)

    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeDefined()
      expect(screen.getByText('Network error: 504 Gateway Timeout')).toBeDefined()
    })

    // Button is still enabled so user can retry
    expect((saveButton as HTMLButtonElement).disabled).toBe(false)
  })

  it('immediately clears saved state when editing within 3s after saving', async () => {
    vi.mocked(adminApi.updateSettings).mockResolvedValue(undefined as never)

    render(<AdminSettings />)

    await waitFor(() => {
      expect(screen.queryByText('Loading…')).toBeNull()
    })

    const appNameInput = screen.getByLabelText('App name')
    fireEvent.change(appNameInput, { target: { value: 'Zeta Enterprise' } })

    const saveButton = screen.getByRole('button', { name: 'Save changes' })
    fireEvent.click(saveButton)

    await waitFor(() => {
      expect(screen.getByText('Saved!')).toBeDefined()
    })

    // Edit field immediately while saved status is still active
    fireEvent.change(appNameInput, { target: { value: 'Zeta Next' } })

    // "Saved!" label must be cleared immediately and replaced with "Unsaved changes"
    expect(screen.queryByText('Saved!')).toBeNull()
    expect(screen.getByText('Unsaved changes')).toBeDefined()
    expect((saveButton as HTMLButtonElement).disabled).toBe(false)
  })

  it('preserves concurrent edits made during in-flight save round-trip', async () => {
    let resolveUpdate: () => void
    const updatePromise = new Promise<void>((resolve) => {
      resolveUpdate = resolve
    })
    vi.mocked(adminApi.updateSettings).mockImplementation(() => updatePromise as never)

    render(<AdminSettings />)

    await waitFor(() => {
      expect(screen.queryByText('Loading…')).toBeNull()
    })

    // Switch to SMTP
    const smtpRadio = screen.getByLabelText('SMTP')
    fireEvent.click(smtpRadio)

    const hostInput = screen.getByLabelText('SMTP host')
    fireEvent.change(hostInput, { target: { value: 'smtp.initial.com' } })

    const saveButton = screen.getByRole('button', { name: 'Save changes' }) as HTMLButtonElement
    fireEvent.click(saveButton)
    expect(saveButton.disabled).toBe(true)

    // Concurrently edit host while save request is in flight
    fireEvent.change(hostInput, { target: { value: 'smtp.concurrent.com' } })

    // Request finishes
    resolveUpdate!()
    await waitFor(() => {
      expect((hostInput as HTMLInputElement).value).toBe('smtp.concurrent.com')
    })

    // The concurrent edit is retained and dirty status correctly reflects remaining unsaved changes
    expect(screen.getByText('Unsaved changes')).toBeDefined()
    expect(saveButton.disabled).toBe(false)
  })
})
