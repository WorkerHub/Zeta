export type SqlClass = 'read' | 'write' | 'destructive' | 'forbidden' | 'multiple' | 'empty'
export type Permission = 'read' | 'write' | 'write_drop'

export interface Token {
  type: 'word' | 'quoted' | 'punct'
  value: string
  start: number // offset in the source SQL
}

// Comments are dropped and quoted strings/identifiers become opaque tokens, so
// keywords or parentheses hidden inside them can never influence classification.
// `openComment` reports a trailing /* comment that is never closed (SQLite lets it run to the end).
function scan(sql: string): { tokens: Token[]; openComment: boolean } {
  const tokens: Token[] = []
  let openComment = false
  const n = sql.length
  let i = 0
  while (i < n) {
    const ch = sql[i]!
    const start = i
    if (/\s/.test(ch)) {
      i++
    } else if (ch === '-' && sql[i + 1] === '-') {
      while (i < n && sql[i] !== '\n') i++
    } else if (ch === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2)
      if (end === -1) openComment = true
      i = end === -1 ? n : end + 2
    } else if (ch === "'" || ch === '"' || ch === '`') {
      i++
      while (i < n) {
        if (sql[i] === ch) {
          if (sql[i + 1] === ch) i += 2
          else break
        } else i++
      }
      i++
      tokens.push({ type: 'quoted', value: '', start })
    } else if (ch === '[') {
      const end = sql.indexOf(']', i + 1)
      i = end === -1 ? n : end + 1
      tokens.push({ type: 'quoted', value: '', start })
    } else if (/[A-Za-z0-9_$\u0080-￿]/.test(ch)) {
      while (i < n && /[A-Za-z0-9_$\u0080-￿]/.test(sql[i]!)) i++
      tokens.push({ type: 'word', value: sql.slice(start, i).toLowerCase(), start })
    } else {
      tokens.push({ type: 'punct', value: ch, start })
      i++
    }
  }
  return { tokens, openComment }
}

// Exported for the app-DB guardrail (lib/app-db-guard.ts), which reuses the same tokens so the
// two modules can never disagree about what counts as a word/quoted/punct token.
export function tokenize(sql: string): Token[] {
  return scan(sql).tokens
}

const READ_PRAGMAS = new Set([
  'table_info',
  'table_xinfo',
  'table_list',
  'index_list',
  'index_info',
  'index_xinfo',
  'foreign_key_list',
  'foreign_key_check',
  'database_list',
  'collation_list',
  'function_list',
  'module_list',
  'pragma_list',
  'compile_options',
  'integrity_check',
  'quick_check',
])

const CTE_WRITE_KEYWORDS = new Set(['insert', 'update', 'delete', 'replace'])

function classifyStatement(tokens: Token[]): SqlClass {
  const first = tokens[0]
  if (first?.type !== 'word') return 'write'

  switch (first.value) {
    case 'select':
    case 'values':
    case 'explain':
      return 'read'

    case 'with': {
      // Depth-0 words after WITH are CTE names/keywords plus the main statement.
      // Anything that is not clearly a plain SELECT is treated as a write.
      let depth = 0
      let hasSelect = false
      for (let i = 1; i < tokens.length; i++) {
        const t = tokens[i]!
        if (t.type === 'punct') {
          if (t.value === '(') depth++
          else if (t.value === ')') depth = Math.max(0, depth - 1)
          continue
        }
        if (depth !== 0 || t.type !== 'word') continue
        if (t.value === 'replace' && tokens[i + 1]?.value === '(') continue // replace() function
        if (CTE_WRITE_KEYWORDS.has(t.value)) return 'write'
        if (t.value === 'select' || t.value === 'values') hasSelect = true
      }
      return hasSelect ? 'read' : 'write'
    }

    case 'pragma': {
      if (tokens.some((t) => t.type === 'punct' && t.value === '=')) return 'forbidden'
      const nameIdx = tokens[2]?.value === '.' ? 3 : 1
      const name = tokens[nameIdx]
      return name?.type === 'word' && READ_PRAGMAS.has(name.value) ? 'read' : 'forbidden'
    }

    case 'attach':
    case 'detach':
      return 'forbidden'

    case 'drop':
    case 'truncate':
      return 'destructive'

    case 'alter':
      return tokens.some((t) => t.type === 'word' && t.value === 'drop') ? 'destructive' : 'write'

    default:
      return 'write'
  }
}

export function classifySql(sql: string): SqlClass {
  const statements: Token[][] = [[]]
  for (const t of tokenize(sql)) {
    if (t.type === 'punct' && t.value === ';') statements.push([])
    else statements[statements.length - 1]!.push(t)
  }
  const nonEmpty = statements.filter((s) => s.length > 0)
  if (nonEmpty.length === 0) return 'empty'
  if (nonEmpty.length > 1) return 'multiple'
  return classifyStatement(nonEmpty[0]!)
}

export function isWriteClass(kind: SqlClass): boolean {
  return kind === 'write' || kind === 'destructive'
}

// Returns an error message when the statement must be rejected, otherwise null.
export function checkSqlAccess(kind: SqlClass, permission: Permission): string | null {
  if (kind === 'forbidden') return 'This SQL statement is not allowed.'
  if (kind === 'multiple') return 'Only one statement is allowed per request.'
  if (kind === 'empty') return 'SQL is empty.'
  if (kind === 'destructive' && permission !== 'write_drop') {
    return 'This statement requires elevated permissions (level 3: write & drop).'
  }
  if (isWriteClass(kind) && permission === 'read') return 'You only have read access to this database.'
  return null
}

// Statements that can be used as a subquery, so a LIMIT around them caps the rows the database
// produces. EXPLAIN and PRAGMA cannot be wrapped; callers cap their (small) output afterwards.
const WRAPPABLE_READS = new Set(['select', 'values', 'with'])

// Rewrites a read statement as `SELECT * FROM (<sql>) LIMIT maxRows + 1`, so the database stops
// after one row more than the caller keeps (that extra row tells it the result was cut off). A
// LIMIT/OFFSET, ORDER BY or WITH inside the statement keeps its meaning in the subquery. Returns
// null for reads that cannot be wrapped. Only call it for SQL that classifySql() rated 'read' and
// that passed checkSqlAccess(): a statement with a second `;`-separated statement never gets here.
export function limitReadSql(sql: string, maxRows: number): string | null {
  const { tokens } = scan(sql)
  const first = tokens[0]
  if (first?.type !== 'word' || !WRAPPABLE_READS.has(first.value)) return null
  // Unbalanced parentheses could move the closing `) LIMIT` into a subquery of the user's (e.g.
  // `SELECT 1), t WHERE x IN (SELECT 1`), leaving the outer query uncapped. Such SQL is invalid
  // anyway: run it as is and let the database reject it.
  let depth = 0
  for (const t of tokens) {
    if (t.type !== 'punct') continue
    if (t.value === '(') depth++
    else if (t.value === ')' && --depth < 0) return null
  }
  if (depth !== 0) return null
  // A single statement can only have a `;` at its end: drop it so the statement fits in parentheses
  const semicolon = tokens.find((t) => t.type === 'punct' && t.value === ';')
  let body = semicolon ? sql.slice(0, semicolon.start) : sql
  // Close a trailing /* comment, and end a trailing -- comment with the newline, so neither can
  // swallow the closing parenthesis
  if (scan(body).openComment) body += '*/'
  return `SELECT * FROM (\n${body}\n) LIMIT ${maxRows + 1}`
}
