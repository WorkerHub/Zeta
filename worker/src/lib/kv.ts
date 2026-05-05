// All KV key constructors in one place – never scatter raw strings
export const KV = {
  // Email verification tokens (24h TTL)
  emailVerify: (token: string) => `email_verify:${token}`,
  // Password reset tokens (1h TTL)
  passwordReset: (token: string) => `pw_reset:${token}`,
  // Email OTP (10min TTL) – value is otp code
  emailOtp: (userId: string) => `email_otp:${userId}`,
  // Refresh token JTI denylist (7d TTL)
  jtiDeny: (jti: string) => `jti_deny:${jti}`,
  // Passkey challenge (5min TTL)
  passkeyChallenge: (userId: string) => `pk_challenge:${userId}`,
  passkeyRegChallenge: (userId: string) => `pk_reg_challenge:${userId}`,
  // Login attempt rate limiting (15min TTL)
  loginAttempts: (ip: string) => `login_attempts:${ip}`,
  // 2FA attempt rate limiting (10min TTL)
  twoFactorAttempts: (userId: string) => `2fa_attempts:${userId}`,
  // TOTP replay prevention (90s TTL)
  totpUsed: (userId: string, code: string) => `totp_used:${userId}:${code}`,
  // Session invalidation after password change (7d TTL)
  sessionInvalidatedAt: (userId: string) => `session_invalidated:${userId}`,
  // TOTP setup (5min TTL)
  totpSetup: (userId: string) => `totp_setup:${userId}`,
  // Email sending rate limiting (15min TTL)
  emailAttempts: (ip: string) => `email_attempts:${ip}`,
  // Registration rate limiting (15min TTL)
  registerAttempts: (ip: string) => `register_attempts:${ip}`,
}
