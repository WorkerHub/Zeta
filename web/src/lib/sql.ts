// Rows a read statement returns at most; the server caps it in the SQL itself (worker MAX_RESULT_ROWS)
export const MAX_RESULT_ROWS = 5000

/**
 * Split a SQL string into individual statements on `;`, ignoring semicolons
 * inside single-quoted strings (`''` escape), line comments (`--`), and
 * block comments (`/* *\/`). Filters empty/whitespace-only results.
 */
export function splitSqlStatements(sql: string): string[] {
  const statements: string[] = []
  let current = ''
  let i = 0

  while (i < sql.length) {
    const ch = sql[i]

    // Line comment: -- ... \n
    if (ch === '-' && sql[i + 1] === '-') {
      while (i < sql.length && sql[i] !== '\n') {
        current += sql[i++]
      }
      continue
    }

    // Block comment: /* ... */
    if (ch === '/' && sql[i + 1] === '*') {
      current += sql[i++] // /
      current += sql[i++] // *
      while (i < sql.length) {
        if (sql[i] === '*' && sql[i + 1] === '/') {
          current += sql[i++] // *
          current += sql[i++] // /
          break
        }
        current += sql[i++]
      }
      continue
    }

    // Single-quoted string: '...' with '' escapes
    if (ch === "'") {
      current += sql[i++]
      while (i < sql.length) {
        if (sql[i] === "'") {
          current += sql[i++]
          if (sql[i] === "'") {
            // '' is an escaped quote — stay inside the string
            current += sql[i++]
          } else {
            // Closing quote
            break
          }
        } else {
          current += sql[i++]
        }
      }
      continue
    }

    // Double-quoted identifier: "..." with "" escapes
    if (ch === '"') {
      current += sql[i++]
      while (i < sql.length) {
        if (sql[i] === '"') {
          current += sql[i++]
          if (sql[i] === '"') {
            current += sql[i++]
          } else {
            break
          }
        } else {
          current += sql[i++]
        }
      }
      continue
    }

    // Backtick-quoted identifier: `...`
    if (ch === '`') {
      current += sql[i++]
      while (i < sql.length && sql[i] !== '`') {
        current += sql[i++]
      }
      if (i < sql.length) current += sql[i++]
      continue
    }

    // Statement terminator
    if (ch === ';') {
      const trimmed = current.trim()
      if (trimmed) statements.push(trimmed)
      current = ''
      i++
      continue
    }

    current += sql[i++]
  }

  // Trailing statement without a terminating semicolon
  const trimmed = current.trim()
  if (trimmed) statements.push(trimmed)

  return statements
}

// Leading whitespace and comments carry no meaning for the first keyword: `-- note\nUSE db` is a
// USE like any other.
function stripLeadingComments(sql: string): string {
  let rest = sql
  for (;;) {
    const trimmed = rest.trimStart()
    if (trimmed.startsWith('--') || trimmed.startsWith('#')) {
      const end = trimmed.indexOf('\n')
      if (end === -1) return ''
      rest = trimmed.slice(end + 1)
      continue
    }
    if (trimmed.startsWith('/*')) {
      const end = trimmed.indexOf('*/')
      if (end === -1) return ''
      rest = trimmed.slice(end + 2)
      continue
    }
    return trimmed
  }
}

// The database a `USE` statement points the session at, or null for anything else. The page needs it
// because the worker never echoes the pinned database back: a run that switched the MySQL session
// records the name here, so the next request can carry it (lib/connection-state.ts). Only the first
// keyword decides — `USERS` and `SELECT 'use x'` are not this statement — and the identifier is
// unquoted the way MySQL quotes it (backticks, doubling inside).
export function usedDatabaseOf(statement: string): string | null {
  const match = /^use\s+([\s\S]+)$/i.exec(stripLeadingComments(statement))
  if (!match) return null
  let target = match[1]!.trim()
  if (target.endsWith(';')) target = target.slice(0, -1).trim()
  if (!target) return null

  const quote = target[0]
  if (quote === '`' || quote === '"') {
    if (target.length < 2 || !target.endsWith(quote)) return null
    // Inside the quotes a quote character must be doubled; a single one ends the identifier early
    // and leaves something after it, which is not a plain USE.
    const inner = target.slice(1, -1)
    let name = ''
    for (let i = 0; i < inner.length; i++) {
      const char = inner[i]!
      if (char !== quote) {
        name += char
        continue
      }
      if (inner[i + 1] !== quote) return null
      name += quote
      i++
    }
    return name !== '' ? name : null
  }
  return /^[^\s;'"`]+$/.test(target) ? target : null
}
