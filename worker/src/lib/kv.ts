// All KV key constructors in one place – never scatter raw strings
export const KV = {
  // Email verification tokens (24h TTL)
  emailVerify: (token: string) => `email_verify:${token}`,
  // Password reset tokens (1h TTL)
  passwordReset: (token: string) => `pw_reset:${token}`,
  // Pending 2FA (10min TTL) – value is user id
  pending2fa: (token: string) => `pending_2fa:${token}`,
  // Email OTP (10min TTL) – value is otp code
  emailOtp: (userId: string) => `email_otp:${userId}`,
  // Refresh token JTI denylist (7d TTL)
  jtiDeny: (jti: string) => `jti_deny:${jti}`,
  // Passkey challenge (5min TTL)
  passkeyChallenge: (userId: string) => `pk_challenge:${userId}`,
  // Login attempt rate limiting (15min TTL)
  loginAttempts: (ip: string) => `login_attempts:${ip}`,
}
