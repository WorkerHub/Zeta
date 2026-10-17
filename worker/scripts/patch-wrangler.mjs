// Fills the *_PLACEHOLDER values in wrangler.toml from environment variables and appends the
// optional QUERY_DB_<n> bindings. Used by .github/workflows/deploy.yml.
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
]

export const MAX_QUERY_DBS = 10

// JSON string escapes (\" \\ \n \uXXXX ...) are all valid in TOML basic strings.
export const tomlString = (value) => JSON.stringify(value)

/**
 * @param {string} template wrangler.toml contents
 * @param {Record<string, string | undefined>} env
 * @returns {{ toml: string, log: string[] }}
 */
export function patchWrangler(template, env) {
  const log = []
  let toml = template

  for (const [placeholder, name] of PLACEHOLDERS) {
    const value = env[name]?.trim()
    if (!value) throw new Error(`${name} is not set`)
    const quoted = `"${placeholder}"`
    const parts = toml.split(quoted)
    if (parts.length !== 2) throw new Error(`Expected exactly one ${quoted} in wrangler.toml`)
    // split/join instead of String#replace, which would interpret `$&`, `$'` etc. in the value
    toml = parts.join(tomlString(value))
  }

  for (let i = 1; i <= MAX_QUERY_DBS; i++) {
    const dbName = env[`QUERY_DB_${i}_NAME`]?.trim()
    const dbId = env[`QUERY_DB_${i}_ID`]?.trim()
    if (dbName && dbId) {
      toml += `\n[[d1_databases]]\nbinding = "QUERY_DB_${i}"\ndatabase_name = ${tomlString(dbName)}\ndatabase_id   = ${tomlString(dbId)}\n`
      // Quoted so a newline in the value cannot start a GitHub Actions `::command::` line
      log.push(`Appended QUERY_DB_${i}: name=${tomlString(dbName)}`)
    } else if (dbName || dbId) {
      log.push(
        `WARNING: QUERY_DB_${i} incomplete — both QUERY_DB_${i}_NAME and QUERY_DB_${i}_ID must be set. Skipping.`
      )
    }
  }

  return { toml, log }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const file = process.argv[2] ?? 'wrangler.toml'
  try {
    const { toml, log } = patchWrangler(readFileSync(file, 'utf8'), process.env)
    writeFileSync(file, toml)
    for (const line of log) console.log(line)
  } catch (err) {
    console.error(`::error::patch-wrangler: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }
}
