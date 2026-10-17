// Tiny URL-safe nanoid implementation using WebCrypto (CF Workers compatible)
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

export function nanoid(size = 21): string {
  const bytes = crypto.getRandomValues(new Uint8Array(size))
  return Array.from(bytes, (b) => ALPHABET[b & 63]).join('')
}

export function uuid(): string {
  return crypto.randomUUID()
}

// Uniformly random 6-digit code (100000–999999). Rejection sampling: 2^32 is not a multiple of
// 900000, so a plain modulo would make the lowest codes very slightly more likely.
export function otpCode(): string {
  const RANGE = 900_000
  const limit = 2 ** 32 - (2 ** 32 % RANGE)
  const buf = new Uint32Array(1)
  for (;;) {
    const n = crypto.getRandomValues(buf)[0]!
    if (n < limit) return String((n % RANGE) + 100_000)
  }
}
