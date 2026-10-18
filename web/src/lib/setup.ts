// Pure helpers for the /setup page, kept free of React so they can be unit-tested alongside the
// other lib modules (the web test suite has no DOM/component testing).

export type SetupView = 'form' | 'disabled'

// Decides what the page shows from GET /api/setup/state. `null` means the state request failed
// (network/5xx): the page then treats setup as available, per the contract.
export function resolveSetupView(enabled: boolean | null): SetupView {
  return enabled === false ? 'disabled' : 'form'
}

export interface SetupErrorInfo {
  // Translation key for the user-facing message.
  key: string
  // Extra {placeholders} for the key (e.g. the Retry-After seconds).
  vars?: Record<string, string | number>
}

// Maps a failed POST /api/setup to a user-facing message. The status code, the `Retry-After`
// header and the server's error text drive the specific copy (403 wrong secret, 400 missing
// secret, 429 rate limited, 500 with SETUP_SECRET → misconfigured Worker).
export function setupErrorInfo(status: number, message: string, retryAfter: string | null): SetupErrorInfo {
  if (status === 403) return { key: 'setup.error_wrong_secret' }
  if (status === 400) return { key: 'setup.error_missing_secret' }
  if (status === 429) {
    const seconds = Number.parseInt(retryAfter ?? '', 10)
    if (Number.isFinite(seconds) && seconds > 0) {
      return { key: 'setup.error_rate_limited_retry', vars: { n: seconds } }
    }
    return { key: 'setup.error_rate_limited' }
  }
  if (status === 500 && /SETUP_SECRET/i.test(message)) return { key: 'setup.error_setup_secret_unset' }
  return { key: 'errors.generic' }
}
