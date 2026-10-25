// Fills the *_PLACEHOLDER values in wrangler.toml from environment variables. Used by
// .github/workflows/deploy.yml.
//
// Values are written as escaped TOML strings, so characters such as `"`, `\`, `/`, `&` or
// newlines in a variable can never break out of the string or inject extra TOML.
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const PLACEHOLDERS = [
  ['CLOUDFLARE_ACCOUNT_ID_PLACEHOLDER', 'CLOUDFLARE_ACCOUNT_ID'],
  ['D1_DATABASE_NAME_PLACEHOLDER', 'D1_DATABASE_NAME'],
  ['D1_DATABASE_ID_PLACEHOLDER', 'D1_DATABASE_ID'],
  ['KV_NAMESPACE_ID_PLACEHOLDER', 'KV_NAMESPACE_ID'],
  ['CF_ACCOUNT_ID_PLACEHOLDER', 'CLOUDFLARE_ACCOUNT_ID'],
  ['ZETA_APP_DB_ID_PLACEHOLDER', 'D1_DATABASE_ID'],
]

// Optional placeholders never fail the build: an unset or blank GitHub repo Variable is
// injected as the fail-closed default instead. `ALLOW_APP_DB_AS_TARGET` is read-only and off
// by default, so a deployment that never configures it must still deploy — with the switch
// clearly off rather than an error. Only trim happens here; the case-insensitive `true` parse
// belongs to the runtime helper (`appDbTargetAllowed` in src/lib/d1-http.ts), so any other
// value is injected verbatim and stays off at runtime.
const OPTIONAL_PLACEHOLDERS = [['ALLOW_APP_DB_AS_TARGET_PLACEHOLDER', 'ALLOW_APP_DB_AS_TARGET', 'false']]

// JSON string escapes (\" \\ \n \uXXXX ...) are all valid in TOML basic strings.
export const tomlString = (value) => JSON.stringify(value)

function fillPlaceholder(toml, placeholder, value) {
  const quoted = `"${placeholder}"`
  const parts = toml.split(quoted)
  if (parts.length !== 2) throw new Error(`Expected exactly one ${quoted} in wrangler.toml`)
  // split/join instead of String#replace, which would interpret `$&`, `$'` etc. in the value
  return parts.join(tomlString(value))
}

/**
 * @param {string} template wrangler.toml contents
 * @param {Record<string, string | undefined>} env
 * @returns {{ toml: string }}
 */
export function patchWrangler(template, env) {
  let toml = template
  for (const [placeholder, name] of PLACEHOLDERS) {
    const value = env[name]?.trim()
    if (!value) throw new Error(`${name} is not set`)
    toml = fillPlaceholder(toml, placeholder, value)
  }
  for (const [placeholder, name, fallback] of OPTIONAL_PLACEHOLDERS) {
    toml = fillPlaceholder(toml, placeholder, env[name]?.trim() || fallback)
  }
  return { toml }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const file = process.argv[2] ?? 'wrangler.toml'
  try {
    const { toml } = patchWrangler(readFileSync(file, 'utf8'), process.env)
    writeFileSync(file, toml)
  } catch (err) {
    console.error(`::error::patch-wrangler: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }
}
