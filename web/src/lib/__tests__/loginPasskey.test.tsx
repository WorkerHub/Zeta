// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import Login from '../../pages/Login'
import { authApi } from '../api'
import { startAuthentication } from '@simplewebauthn/browser'
import { setLocale, t } from '../translations'

const mockNavigate = vi.fn()
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom')
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  }
})

const mockLogin = vi.fn()
vi.mock('../../hooks/useAuth', () => ({
  useAuthContext: () => ({
    login: mockLogin,
    user: null,
    loading: false,
    logout: vi.fn(),
    refresh: vi.fn(),
  }),
}))

vi.mock('../api', () => ({
  authApi: {
    registerStatus: vi.fn().mockResolvedValue({ enabled: true }),
    login: vi.fn(),
    passkeyLoginOptions: vi.fn(),
    passkeyLoginVerify: vi.fn(),
  },
  ApiError: class ApiError extends Error {
    status: number
    constructor(message: string, status: number) {
      super(message)
      this.name = 'ApiError'
      this.status = status
    }
  },
}))

vi.mock('@simplewebauthn/browser', () => ({
  startAuthentication: vi.fn(),
}))

describe('Login with Passkey', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setLocale('en')
    vi.mocked(authApi.registerStatus).mockResolvedValue({ enabled: true })
  })

  afterEach(() => {
    cleanup()
  })

  it('renders divider and passkey sign in button', () => {
    render(
      <MemoryRouter>
        <Login />
      </MemoryRouter>
    )

    expect(screen.getByText(t('auth.or'))).toBeDefined()
    expect(screen.getByRole('button', { name: new RegExp(t('auth.signin_with_passkey')) })).toBeDefined()
  })

  it('completes passkey login directly and navigates to /query without 2FA step', async () => {
    const mockOptions = { challenge: 'test-challenge-123' }
    const mockCredResult = {
      id: 'cred-1',
      rawId: 'raw-1',
      response: { clientDataJSON: 'xyz', authenticatorData: 'abc' },
      type: 'public-key',
    }
    const mockVerifyResponse = {
      accessToken: 'jwt-access-token',
      user: {
        id: 'u-1',
        email: 'user@example.com',
        name: 'Test User',
        role: 'member' as const,
        email_verified: 1,
        two_factor_required: 0,
        created_at: 1700000000,
      },
    }

    vi.mocked(authApi.passkeyLoginOptions).mockResolvedValue(mockOptions)
    vi.mocked(startAuthentication).mockResolvedValue(
      mockCredResult as unknown as Awaited<ReturnType<typeof startAuthentication>>
    )
    vi.mocked(authApi.passkeyLoginVerify).mockResolvedValue(mockVerifyResponse)

    render(
      <MemoryRouter>
        <Login />
      </MemoryRouter>
    )

    const passkeyBtn = screen.getByRole('button', { name: new RegExp(t('auth.signin_with_passkey')) })
    fireEvent.click(passkeyBtn)

    await waitFor(() => {
      expect(authApi.passkeyLoginOptions).toHaveBeenCalledTimes(1)
      expect(startAuthentication).toHaveBeenCalledWith({
        optionsJSON: mockOptions,
      })
      expect(authApi.passkeyLoginVerify).toHaveBeenCalledWith(mockCredResult)
      expect(mockLogin).toHaveBeenCalledWith('jwt-access-token', mockVerifyResponse.user)
      expect(mockNavigate).toHaveBeenCalledWith('/query')
    })

    // No 2FA modal should be rendered
    expect(screen.queryByText(t('2fa.title'))).toBeNull()
  })

  it('handles user cancellation (NotAllowedError) gracefully', async () => {
    vi.mocked(authApi.passkeyLoginOptions).mockResolvedValue({ challenge: 'test-ch' })
    const notAllowedError = new Error('The operation either timed out or was not allowed.')
    notAllowedError.name = 'NotAllowedError'
    vi.mocked(startAuthentication).mockRejectedValue(notAllowedError)

    render(
      <MemoryRouter>
        <Login />
      </MemoryRouter>
    )

    const passkeyBtn = screen.getByRole('button', { name: new RegExp(t('auth.signin_with_passkey')) })
    fireEvent.click(passkeyBtn)

    await waitFor(() => {
      expect(screen.getByText(t('errors.passkey_cancelled'))).toBeDefined()
    })
    expect(mockLogin).not.toHaveBeenCalled()
    expect(mockNavigate).not.toHaveBeenCalled()
  })

  it('displays API error message on verify failure (e.g. 401 unified message or 403 unverified email)', async () => {
    vi.mocked(authApi.passkeyLoginOptions).mockResolvedValue({ challenge: 'test-ch' })
    vi.mocked(startAuthentication).mockResolvedValue({ id: 'dummy' } as unknown as Awaited<
      ReturnType<typeof startAuthentication>
    >)
    vi.mocked(authApi.passkeyLoginVerify).mockRejectedValue(new Error('Invalid credentials'))

    render(
      <MemoryRouter>
        <Login />
      </MemoryRouter>
    )

    const passkeyBtn = screen.getByRole('button', { name: new RegExp(t('auth.signin_with_passkey')) })
    fireEvent.click(passkeyBtn)

    await waitFor(() => {
      expect(screen.getByText('Invalid credentials')).toBeDefined()
    })
  })

  it('shows waiting label and disables both login buttons while passkey login is in progress', async () => {
    let resolveOptions!: (val: Record<string, unknown>) => void
    const optionsPromise = new Promise<Record<string, unknown>>((resolve) => {
      resolveOptions = resolve
    })
    vi.mocked(authApi.passkeyLoginOptions).mockReturnValue(optionsPromise)

    render(
      <MemoryRouter>
        <Login />
      </MemoryRouter>
    )

    const passkeyBtn = screen.getByRole('button', {
      name: new RegExp(t('auth.signin_with_passkey')),
    }) as HTMLButtonElement
    const submitBtn = screen.getByRole('button', { name: t('auth.signin') }) as HTMLButtonElement

    expect(passkeyBtn.disabled).toBe(false)
    expect(submitBtn.disabled).toBe(false)

    fireEvent.click(passkeyBtn)

    // While waiting
    await waitFor(() => {
      expect(screen.getByText(t('profile.passkey_waiting'))).toBeDefined()
      const waitingBtn = screen.getByRole('button', {
        name: new RegExp(t('profile.passkey_waiting')),
      }) as HTMLButtonElement
      expect(waitingBtn.disabled).toBe(true)
      expect(submitBtn.disabled).toBe(true)
    })

    // Resolve options and complete flow
    resolveOptions({ challenge: 'ch' })
    vi.mocked(startAuthentication).mockResolvedValue({ id: 'c' } as unknown as Awaited<
      ReturnType<typeof startAuthentication>
    >)
    vi.mocked(authApi.passkeyLoginVerify).mockResolvedValue({
      accessToken: 'tok',
      user: {
        id: 'u1',
        email: 'e',
        name: 'n',
        role: 'member',
        email_verified: 1,
        two_factor_required: 0,
        created_at: 1700000000,
      },
    })

    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith('/query')
    })
  })

  it('clears previous passkey error when submitting password form, and vice versa', async () => {
    vi.mocked(authApi.passkeyLoginOptions).mockRejectedValue(new Error('Passkey network failed'))
    vi.mocked(authApi.login).mockRejectedValue(new Error('Password incorrect'))

    render(
      <MemoryRouter>
        <Login />
      </MemoryRouter>
    )

    const passkeyBtn = screen.getByRole('button', { name: new RegExp(t('auth.signin_with_passkey')) })
    fireEvent.click(passkeyBtn)

    await waitFor(() => {
      expect(screen.getByText('Passkey network failed')).toBeDefined()
    })

    // Now fill email/password and submit password form
    const emailInput = screen.getByPlaceholderText(t('auth.placeholder_email'))
    const passwordInput = screen.getByPlaceholderText('••••••••')
    fireEvent.change(emailInput, { target: { value: 'user@example.com' } })
    fireEvent.change(passwordInput, { target: { value: 'secretpass' } })

    const submitBtn = screen.getByRole('button', { name: t('auth.signin') })
    fireEvent.click(submitBtn)

    await waitFor(() => {
      expect(screen.getByText('Password incorrect')).toBeDefined()
      expect(screen.queryByText('Passkey network failed')).toBeNull()
    })

    // Clicking passkey login again should clear password error
    fireEvent.click(passkeyBtn)
    await waitFor(() => {
      expect(screen.queryByText('Password incorrect')).toBeNull()
      expect(screen.getByText('Passkey network failed')).toBeDefined()
    })
  })
})
