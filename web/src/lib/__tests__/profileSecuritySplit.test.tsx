// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { MemoryRouter, Routes, Route, useOutletContext } from 'react-router-dom'
import ProfilePage from '../../pages/Profile'
import SecurityPage from '../../pages/Security'
import AccountLayout from '../../pages/AccountLayout'
import { profileApi } from '../api'
import { setLocale, t } from '../translations'
import type { User, RunSettings } from '../../types'

vi.mock('../api', () => ({
  profileApi: {
    me: vi.fn(),
    runSettings: vi.fn(),
    updateRunSettings: vi.fn(),
    changePassword: vi.fn(),
    setupTotp: vi.fn(),
    confirmTotp: vi.fn(),
    deleteTotp: vi.fn(),
    passkeyRegisterOptions: vi.fn(),
    passkeyRegisterVerify: vi.fn(),
    deletePasskey: vi.fn(),
  },
  ApiError: class ApiError extends Error {
    status: number
    constructor(status: number, message: string) {
      super(message)
      this.status = status
    }
  },
}))

vi.mock('../../hooks/useThemeColor', () => ({
  useThemeColor: () => ({
    themeColor: 'ocean',
    setThemeColor: vi.fn(),
    syncError: null,
  }),
}))

afterEach(() => {
  cleanup()
  setLocale('en')
  vi.clearAllMocks()
})

const mockUser: User = {
  id: 'u-1',
  email: 'test@example.com',
  name: 'Test User',
  role: 'member',
  email_verified: 1,
  two_factor_required: 0,
  created_at: 1700000000,
  totpCredentials: [
    {
      id: 'totp-1',
      name: 'Authenticator 1',
      created_at: 1700000000,
    },
  ],
  passkeyCredentials: [
    {
      id: 'passkey-1',
      name: 'My Macbook TouchID',
      created_at: 1700000000,
    },
  ],
}

const mockRunSettings: RunSettings = {
  run_limit: 10,
  admin_run_limit: 50,
  effective_run_limit: 10,
  storage_used_bytes: 1024,
  storage_quota_bytes: 10485760,
}

function ChildWithDirty() {
  const { setDirty } = useOutletContext<{ setDirty: (d: boolean) => void }>()
  return (
    <button type="button" onClick={() => setDirty(true)}>
      Make dirty
    </button>
  )
}

describe('Profile / Security Page Split', () => {
  beforeEach(() => {
    vi.mocked(profileApi.me).mockResolvedValue({ ...mockUser })
    vi.mocked(profileApi.runSettings).mockResolvedValue({ ...mockRunSettings })
  })

  describe('ProfilePage', () => {
    it('renders account info, theme color, run settings, and StickySaveBar, but no security items', async () => {
      const { container } = render(
        <MemoryRouter>
          <ProfilePage />
        </MemoryRouter>
      )

      await waitFor(() => {
        expect(screen.queryByText('Loading…')).toBeNull()
      })

      // Account info
      expect(screen.getByText('Account')).toBeDefined()
      expect(screen.getByText('test@example.com')).toBeDefined()
      expect(screen.getByText('Test User')).toBeDefined()

      // Theme color
      expect(screen.getByText(t('profile.theme_color'))).toBeDefined()

      // Run settings input exists without inline save button
      const runInput = screen.getByLabelText(t('profile.run_limit')) as HTMLInputElement
      expect(runInput).toBeDefined()
      expect(runInput.value).toBe('10')

      // Exactly one save button exists on the page (in the sticky save bar)
      const saveButtons = screen.getAllByRole('button', { name: new RegExp(t('admin_settings.save_changes'), 'i') })
      expect(saveButtons).toHaveLength(1)

      // Clearance padding at container bottom
      const contentContainer = container.querySelector('.pb-20')
      expect(contentContainer).not.toBeNull()
      expect(contentContainer?.className).toContain('sm:pb-24')

      // Security cards should NOT exist on Profile page
      expect(screen.queryByText(t('profile.change_password'))).toBeNull()
      expect(screen.queryByText(t('profile.totp_title'))).toBeNull()
      expect(screen.queryByText(t('profile.passkey_title'))).toBeNull()
    })

    it('manages dirty state and saves through StickySaveBar', async () => {
      vi.mocked(profileApi.updateRunSettings).mockResolvedValue({
        ...mockRunSettings,
        run_limit: 25,
        effective_run_limit: 25,
      })

      render(
        <MemoryRouter>
          <ProfilePage />
        </MemoryRouter>
      )

      await waitFor(() => {
        expect(screen.queryByText('Loading…')).toBeNull()
      })

      const saveButton = screen.getByRole('button', { name: new RegExp(t('admin_settings.save_changes'), 'i') })
      // Initially clean: save button disabled, all saved status
      expect(saveButton.hasAttribute('disabled')).toBe(true)
      expect(screen.getByText(t('admin_settings.all_saved'))).toBeDefined()

      // Modify run_limit
      const runInput = screen.getByLabelText(t('profile.run_limit'))
      fireEvent.change(runInput, { target: { value: '25' } })

      // Now dirty: save button enabled, unsaved changes status
      expect(saveButton.hasAttribute('disabled')).toBe(false)
      expect(screen.getByText(t('admin_settings.unsaved_changes'))).toBeDefined()

      // Click save
      fireEvent.click(saveButton)

      await waitFor(() => {
        expect(profileApi.updateRunSettings).toHaveBeenCalledWith({ run_limit: 25 })
      })

      // Saved state
      await waitFor(() => {
        expect(screen.getByText(t('admin_settings.saved'))).toBeDefined()
      })
    })

    it('validates run_limit before saving and intercepts invalid numbers', async () => {
      render(
        <MemoryRouter>
          <ProfilePage />
        </MemoryRouter>
      )

      await waitFor(() => {
        expect(screen.queryByText('Loading…')).toBeNull()
      })

      const runInput = screen.getByLabelText(t('profile.run_limit'))
      fireEvent.change(runInput, { target: { value: '999' } }) // exceeds admin_run_limit 50

      const saveButton = screen.getByRole('button', { name: new RegExp(t('admin_settings.save_changes'), 'i') })
      fireEvent.click(saveButton)

      expect(profileApi.updateRunSettings).not.toHaveBeenCalled()
      expect(screen.getAllByText(t('profile.run_limit_invalid', { max: 50 })).length).toBeGreaterThanOrEqual(1)
    })
  })

  describe('SecurityPage', () => {
    it('renders password, TOTP, and Passkey cards with their own action buttons, but no StickySaveBar', async () => {
      render(
        <MemoryRouter>
          <SecurityPage />
        </MemoryRouter>
      )

      await waitFor(() => {
        expect(screen.queryByText('Loading…')).toBeNull()
      })

      // Security cards exist
      expect(screen.getByText(t('profile.change_password'))).toBeDefined()
      expect(screen.getByText(t('profile.totp_title'))).toBeDefined()
      expect(screen.getByText(t('profile.passkey_title'))).toBeDefined()

      // Card action buttons exist
      expect(screen.getByRole('button', { name: t('profile.update_password') })).toBeDefined()
      expect(screen.getByRole('button', { name: new RegExp(t('profile.totp_add'), 'i') })).toBeDefined()
      expect(screen.getByRole('button', { name: new RegExp(t('profile.passkey_add'), 'i') })).toBeDefined()

      // Credentials rendered from user
      expect(screen.getByText('Authenticator 1')).toBeDefined()
      expect(screen.getByText('My Macbook TouchID')).toBeDefined()

      // StickySaveBar and Profile-specific items must NOT exist
      expect(screen.queryByRole('region', { name: t('admin_settings.save_bar') })).toBeNull()
      expect(screen.queryByText(t('profile.run_title'))).toBeNull()
      expect(screen.queryByText(t('profile.theme_color'))).toBeNull()
    })

    it('triggers factor removal password modal when trash icon is clicked', async () => {
      render(
        <MemoryRouter>
          <SecurityPage />
        </MemoryRouter>
      )

      await waitFor(() => {
        expect(screen.queryByText('Loading…')).toBeNull()
      })

      // Find delete button for TOTP
      const deleteButtons = screen.getAllByRole('button').filter((btn) => btn.querySelector('svg.lucide-trash-2'))
      expect(deleteButtons.length).toBeGreaterThanOrEqual(1)

      fireEvent.click(deleteButtons[0]!)

      // Removal modal appears
      expect(screen.getByText(t('profile.confirm_delete_totp'))).toBeDefined()
      const currentPasswordInputs = screen.getAllByLabelText(t('profile.current_password'))
      expect(currentPasswordInputs.length).toBe(2)
      expect(screen.getByRole('button', { name: t('profile.remove') })).toBeDefined()
    })
  })

  describe('AccountLayout Navigation', () => {
    it('renders navigation tabs and highlights active tab for /profile and /security', () => {
      const renderWithRoute = (initialPath: string) =>
        render(
          <MemoryRouter initialEntries={[initialPath]}>
            <Routes>
              <Route path="/" element={<AccountLayout />}>
                <Route path="profile" element={<div data-testid="profile-child">Profile Content</div>} />
                <Route path="security" element={<div data-testid="security-child">Security Content</div>} />
              </Route>
            </Routes>
          </MemoryRouter>
        )

      const first = renderWithRoute('/profile')

      // Header links
      expect(screen.getByText('Zeta')).toBeDefined()
      expect(screen.getByText(t('profile.back_to_query'))).toBeDefined()

      // Navigation tabs
      const profileTab = screen.getByRole('link', { name: new RegExp(t('profile.tab_profile'), 'i') })
      const securityTab = screen.getByRole('link', { name: new RegExp(t('profile.tab_security'), 'i') })
      expect(profileTab).toBeDefined()
      expect(securityTab).toBeDefined()

      // Profile is active
      expect(profileTab.className).toContain('border-brand-600')
      expect(securityTab.className).not.toContain('border-brand-600')
      expect(screen.getByTestId('profile-child')).toBeDefined()

      first.unmount()

      renderWithRoute('/security')

      const profileTabSec = screen.getByRole('link', { name: new RegExp(t('profile.tab_profile'), 'i') })
      const securityTabSec = screen.getByRole('link', { name: new RegExp(t('profile.tab_security'), 'i') })
      expect(securityTabSec.className).toContain('border-brand-600')
      expect(profileTabSec.className).not.toContain('border-brand-600')
      expect(screen.getByTestId('security-child')).toBeDefined()
    })

    it('intercepts tab switch when dirty and warns about unsaved changes', () => {
      const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)

      render(
        <MemoryRouter initialEntries={['/profile']}>
          <Routes>
            <Route path="/" element={<AccountLayout />}>
              <Route path="profile" element={<ChildWithDirty />} />
              <Route path="security" element={<div>Security Content</div>} />
            </Route>
          </Routes>
        </MemoryRouter>
      )

      // Make dirty
      fireEvent.click(screen.getByRole('button', { name: 'Make dirty' }))

      // Click security tab
      const securityTab = screen.getByRole('link', { name: new RegExp(t('profile.tab_security'), 'i') })
      fireEvent.click(securityTab)

      expect(confirmSpy).toHaveBeenCalledWith(t('common.unsaved_changes_warning'))
      confirmSpy.mockRestore()
    })
  })
})
