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

// The index just past the quoted run starting at `start`. `'…'` and `"…"` escape their own quote by
// doubling it; a backtick identifier has no escape and ends at the next one. An unterminated run
// reaches the end of the text — the same model splitSqlStatements scans by.
function endOfQuoted(sql: string, start: number): number {
  const quote = sql[start]!
  let i = start + 1
  while (i < sql.length) {
    if (sql[i] !== quote) {
      i++
      continue
    }
    if (quote !== '`' && sql[i + 1] === quote) {
      i += 2
      continue
    }
    return i + 1
  }
  return sql.length
}

/**
 * The text a saved run shows as: the comments in front of each statement are dropped, so the display
 * starts at the statement itself, and the blank lines that came with those comments go too. A
 * comment inside a statement — a trailing `-- note` on the statement's own line, a comment line
 * between its clauses — stays, and text that is nothing but comments comes back unchanged.
 *
 * `splitSqlStatements` scans the same way (single quotes escape by doubling, `#` is MySQL's line
 * comment), but it keeps the comments: this is the display-only variant, and the classification
 * paths that read the first keyword keep using `stripLeadingComments`.
 */
export function stripLeadingCommentsForDisplay(sql: string): string {
  let out = ''
  let i = 0
  // Only whitespace and comments since the start or the last `;`
  let leading = true
  // Whitespace seen while leading: put back unless a comment was dropped (then it goes with it)
  let gap = ''
  // A comment was dropped since the last statement character
  let dropped = false

  // Leave the leading state just before a statement character is written: after a dropped comment
  // one newline keeps the statements apart, otherwise the whitespace seen on the way stays as it was
  const resume = () => {
    if (!dropped) out += gap
    else if (out) out += '\n'
    gap = ''
    dropped = false
    leading = false
  }

  while (i < sql.length) {
    const ch = sql[i]!
    // Line comment: -- anywhere, # only where a comment can be (a `#` inside a statement may be an
    // operator, so there it stays an ordinary character)
    if ((ch === '-' && sql[i + 1] === '-') || (ch === '#' && leading)) {
      const end = sql.indexOf('\n', i)
      const stop = end === -1 ? sql.length : end
      if (leading) {
        dropped = true
        gap = ''
      } else {
        out += sql.slice(i, stop)
      }
      i = stop
      continue
    }
    // Block comment: /* … */, or to the end of the text when it is never closed
    if (ch === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2)
      const stop = end === -1 ? sql.length : end + 2
      if (leading) {
        dropped = true
        gap = ''
      } else {
        out += sql.slice(i, stop)
      }
      i = stop
      continue
    }
    // Quoted text is never a comment, whatever it holds
    if (ch === "'" || ch === '"' || ch === '`') {
      if (leading) resume()
      const stop = endOfQuoted(sql, i)
      out += sql.slice(i, stop)
      i = stop
      continue
    }
    // A statement terminator starts the next statement's leading run
    if (ch === ';') {
      out += ch
      i++
      leading = true
      continue
    }
    if (leading) {
      if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
        if (!dropped) gap += ch
        i++
        continue
      }
      resume()
    }
    out += ch
    i++
  }

  const stripped = out.trim()
  return stripped === '' ? sql : stripped
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
