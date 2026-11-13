// JSON-safe mapping of a query result row.
//
// Query results are returned to the browser as JSON and saved into notebook runs with
// JSON.stringify, so every value must survive that trip. PostgreSQL hands back types JSON has no
// representation for — bigint, Date, binary — so they are converted once, at the executor's exit:
//   * bigint (int8, counts)        → decimal string  (never lose precision through a JS number)
//   * numeric/decimal              → already a string from the driver, kept as is
//   * timestamps / dates           → ISO 8601 string
//   * bytea / binary               → base64 string
// A `json`/`jsonb` value is walked recursively, since it can carry any of these inside.

const BASE64_CHUNK = 0x8000

function bytesToBase64(bytes: Uint8Array): string {
  // Chunked so a large bytea never spreads into a call stack that overflows.
  let binary = ''
  for (let i = 0; i < bytes.length; i += BASE64_CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + BASE64_CHUNK))
  }
  return btoa(binary)
}

export function toJsonSafe(value: unknown): unknown {
  if (value === null || value === undefined) return null

  switch (typeof value) {
    case 'string':
    case 'boolean':
      return value
    case 'number':
      // NaN/Infinity are valid PostgreSQL float8 values but stringify to null; keep them readable.
      return Number.isFinite(value) ? value : String(value)
    case 'bigint':
      return value.toString()
    case 'object':
      break
    default:
      return String(value)
  }

  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString()
  if (value instanceof Uint8Array) return bytesToBase64(value)
  if (value instanceof ArrayBuffer) return bytesToBase64(new Uint8Array(value))
  if (Array.isArray(value)) return value.map(toJsonSafe)
  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) out[key] = toJsonSafe(item)
  return out
}

// Maps a result set as returned by the driver; row keys stay as the SQL produced them.
export function toJsonSafeRows(rows: ReadonlyArray<Record<string, unknown>>): Record<string, unknown>[] {
  return rows.map((row) => toJsonSafe(row) as Record<string, unknown>)
}
