// Tiny URL-safe nanoid implementation using WebCrypto (CF Workers compatible)
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

export function nanoid(size = 21): string {
  const bytes = crypto.getRandomValues(new Uint8Array(size))
  return Array.from(bytes, (b) => ALPHABET[b & 63]).join('')
}

export function uuid(): string {
  return crypto.randomUUID()
}
