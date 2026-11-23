// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import AdminLayout from '../../pages/admin/AdminLayout'
import { setLocale, t } from '../translations'
import querySource from '../../pages/Query.tsx?raw'
import adminLayoutSource from '../../pages/admin/AdminLayout.tsx?raw'
import appSource from '../../App.tsx?raw'
import accountLayoutSource from '../../pages/AccountLayout.tsx?raw'

vi.mock('../../pages/admin/Users', () => ({ default: () => <div data-testid="mock-users" /> }))
vi.mock('../../pages/admin/Databases', () => ({ default: () => <div data-testid="mock-databases" /> }))
vi.mock('../../pages/admin/AdminSettings', () => ({ default: () => <div data-testid="mock-settings" /> }))

vi.mock('../../hooks/useTheme', () => ({
  useTheme: () => ({
    theme: 'light',
    cycleTheme: vi.fn(),
  }),
}))

const mockLogout = vi.fn()
vi.mock('../../hooks/useAuth', () => ({
  useAuthContext: () => ({
    user: {
      id: 'u1',
      name: 'Admin User',
      email: 'admin@example.com',
      role: 'admin',
    },
    logout: mockLogout,
    loading: false,
    refresh: vi.fn(),
  }),
}))

afterEach(() => {
  cleanup()
  setLocale('en')
  vi.clearAllMocks()
})

describe('User Menu External Entrance', () => {
  it('renders "Account settings" entry in user dropdown and points to /profile', () => {
    render(
      <MemoryRouter initialEntries={['/admin']}>
        <AdminLayout />
      </MemoryRouter>
    )

    // User avatar button
    const avatarButton = screen.getByRole('button', { name: 'A' })
    fireEvent.click(avatarButton)

    // Account settings link is present and points to /profile
    const accountLink = screen.getByRole('link', { name: new RegExp(t('user.account_settings'), 'i') })
    expect(accountLink).toBeDefined()
    expect(accountLink.getAttribute('href')).toBe('/profile')

    // Profile and Security should NOT exist as separate entries in the menu
    expect(screen.queryByRole('link', { name: new RegExp(`^${t('user.profile')}$`, 'i') })).toBeNull()
    expect(screen.queryByRole('link', { name: new RegExp(`^${t('user.security')}$`, 'i') })).toBeNull()

    // No link in the dropdown points to /security
    const links = screen.getAllByRole('link')
    const securityLinks = links.filter((l) => l.getAttribute('href') === '/security')
    expect(securityLinks).toHaveLength(0)

    // Clicking account settings closes the menu
    fireEvent.click(accountLink)
    expect(screen.queryByRole('link', { name: new RegExp(t('user.account_settings'), 'i') })).toBeNull()
  })

  it('renders Chinese "账户设置" when locale is zh', () => {
    setLocale('zh')
    render(
      <MemoryRouter initialEntries={['/admin']}>
        <AdminLayout />
      </MemoryRouter>
    )

    const avatarButton = screen.getByRole('button', { name: 'A' })
    fireEvent.click(avatarButton)

    const accountLink = screen.getByRole('link', { name: '账户设置' })
    expect(accountLink).toBeDefined()
    expect(accountLink.getAttribute('href')).toBe('/profile')

    expect(screen.queryByRole('link', { name: '个人资料' })).toBeNull()
    expect(screen.queryByRole('link', { name: '安全设置' })).toBeNull()
  })

  it('verifies Query.tsx and AdminLayout.tsx both collapsed external entries into user.account_settings', () => {
    // Both external user menus link to /profile with user.account_settings
    expect(querySource).toContain('to="/profile"')
    expect(querySource).toContain("t('user.account_settings')")
    expect(adminLayoutSource).toContain('to="/profile"')
    expect(adminLayoutSource).toContain("t('user.account_settings')")

    // Neither external user menu links to /security
    expect(querySource).not.toContain('to="/security"')
    expect(adminLayoutSource).not.toContain('to="/security"')

    // Neither menu references user.security or user.profile
    expect(querySource).not.toContain("t('user.profile')")
    expect(querySource).not.toContain("t('user.security')")
    expect(adminLayoutSource).not.toContain("t('user.profile')")
    expect(adminLayoutSource).not.toContain("t('user.security')")
  })

  it('verifies /security route, defensive redirect, and in-page tabs remain intact', () => {
    // App.tsx routes intact
    expect(appSource).toContain('path="/profile"')
    expect(appSource).toContain('path="/security"')
    expect(appSource).toContain('path="/profile/security"')
    expect(appSource).toContain('to="/security"')

    // AccountLayout in-page tabs intact
    expect(accountLayoutSource).toContain('to="/profile"')
    expect(accountLayoutSource).toContain('to="/security"')
    expect(accountLayoutSource).toContain("t('profile.tab_profile')")
    expect(accountLayoutSource).toContain("t('profile.tab_security')")
  })
})
