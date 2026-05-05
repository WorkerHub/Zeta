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
