export type SqlClass = 'read' | 'write' | 'destructive' | 'forbidden' | 'multiple' | 'empty'
export type Permission = 'read' | 'write' | 'write_drop'
export type SqlDialect = 'sqlite' | 'postgres'

export interface Token {
  type: 'word' | 'quoted' | 'punct'
  value: string
  start: number // offset in the source SQL
}

// PostgreSQL dollar-quoted string: $$…$$ or $tag$…$tag$. Sticky so the scan stays linear.
const DOLLAR_QUOTE = /\$(?:[A-Za-z_\u0080-\uffff][A-Za-z0-9_\u0080-\uffff]*)?\$/y

// The offset just past the closing delimiter of a dollar-quoted string starting at `start`, or
// null when this `$` does not open one (e.g. the `$1` of a positional parameter, `$` inside an
// identifier). The tag is an optional identifier that may not start with a digit.
function dollarQuoteEnd(sql: string, start: number): number | null {
  DOLLAR_QUOTE.lastIndex = start
  const match = DOLLAR_QUOTE.exec(sql)
  if (!match) return null
  const end = sql.indexOf(match[0], start + match[0].length)
  return end === -1 ? sql.length : end + match[0].length
}

// Comments are dropped and quoted strings/identifiers become opaque tokens, so
// keywords or parentheses hidden inside them can never influence classification.
// `openComment` reports a trailing /* comment that is never closed (SQLite lets it run to the end).
//
// In the postgres dialect the two string forms SQLite does not have are opaque as well, otherwise
// their contents (a `;`, a keyword, a `)`) would leak into the token stream:
//   * dollar-quoted bodies ($$…$$, $tag$…$tag$) — function bodies and quoted SQL text,
//   * E'…' escape strings — backslash escapes make a doubled quote the wrong terminator.
function scan(sql: string, dialect: SqlDialect): { tokens: Token[]; openComment: boolean } {
  const tokens: Token[] = []
  let openComment = false
  const n = sql.length
  let i = 0
  while (i < n) {
    const ch = sql[i]!
    const start = i
    // Only `$` can open a dollar-quoted string; the lookup runs once per token.
    const dollarEnd = dialect === 'postgres' && ch === '$' ? dollarQuoteEnd(sql, i) : null
    if (dollarEnd !== null) {
      i = dollarEnd
      tokens.push({ type: 'quoted', value: '', start })
    } else if (/\s/.test(ch)) {
      i++
    } else if (ch === '-' && sql[i + 1] === '-') {
      while (i < n && sql[i] !== '\n') i++
    } else if (ch === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2)
      if (end === -1) openComment = true
      i = end === -1 ? n : end + 2
    } else if (dialect === 'postgres' && (ch === 'e' || ch === 'E') && sql[i + 1] === "'") {
      i += 2
      while (i < n) {
        if (sql[i] === '\\') {
          i += 2
        } else if (sql[i] === "'") {
          if (sql[i + 1] === "'") i += 2
          else {
            i++
            break
          }
        } else i++
      }
      tokens.push({ type: 'quoted', value: '', start })
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
    } else if (/[A-Za-z0-9_$\u0080-\uffff]/.test(ch)) {
      while (i < n && /[A-Za-z0-9_$\u0080-\uffff]/.test(sql[i]!)) i++
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
export function tokenize(sql: string, dialect: SqlDialect = 'sqlite'): Token[] {
  return scan(sql, dialect).tokens
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

// Statements that read a file or load data into/out of the server (COPY … FROM/TO a file,
// MySQL's LOAD DATA): forbidden on every engine.
const FILE_STATEMENTS = new Set(['copy', 'load'])

const CTE_WRITE_KEYWORDS = new Set(['insert', 'update', 'delete', 'replace', 'merge'])

// Index just past the balanced parenthesis group that starts at tokens[open] (a `(`), or
// tokens.length when it never closes.
function skipBalanced(tokens: Token[], open: number): number {
  let depth = 0
  for (let i = open; i < tokens.length; i++) {
    const t = tokens[i]!
    if (t.type !== 'punct') continue
    if (t.value === '(') depth++
    else if (t.value === ')') {
      depth--
      if (depth === 0) return i + 1
    }
  }
  return tokens.length
}

// Strips a WITH [RECURSIVE] cte [(cols)] AS (body), … prefix and returns the tokens of the main
// statement. `fail` covers everything unparseable, including a WITH that ends after its CTE list
// (no main statement at all). Shared with the app-DB guardrail, which needs the same split.
export function stripCte(tokens: Token[]): { main: Token[] } | { fail: true } {
  let i = 1
  const second = tokens[1]
  if (second?.type === 'word' && second.value === 'recursive') i = 2
  for (;;) {
    if (!tokens[i]) return { fail: true } // missing CTE name
    i++ // CTE name (one token; its form is irrelevant here)
    if (tokens[i]?.type === 'punct' && tokens[i]!.value === '(') i = skipBalanced(tokens, i) // column list
    const as = tokens[i]
    if (as?.type !== 'word' || as.value !== 'as') return { fail: true }
    i++
    // PostgreSQL's WITH … AS [NOT] MATERIALIZED (…)
    if (tokens[i]?.type === 'word' && tokens[i]!.value === 'not') i++
    if (tokens[i]?.type === 'word' && tokens[i]!.value === 'materialized') i++
    if (tokens[i]?.type !== 'punct' || tokens[i]!.value !== '(') return { fail: true }
    i = skipBalanced(tokens, i) // CTE body
    if (tokens[i]?.type === 'punct' && tokens[i]!.value === ',') {
      i++
      continue // another CTE follows
    }
    return { main: tokens.slice(i) }
  }
}

// True when a data-modifying keyword appears inside any parenthesis group. CTE bodies always live
// in parentheses while the CTE names and the main statement sit at depth 0, so a CTE that is
// merely named like a keyword cannot trigger this — a body such as
// `WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d` does.
function cteBodyWrites(tokens: Token[]): boolean {
  let depth = 0
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!
    if (t.type === 'punct') {
      if (t.value === '(') depth++
      else if (t.value === ')') depth = Math.max(0, depth - 1)
      continue
    }
    if (depth === 0 || t.type !== 'word') continue
    if (t.value === 'replace' && tokens[i + 1]?.value === '(') continue // replace() function
    if (CTE_WRITE_KEYWORDS.has(t.value)) return true
  }
  return false
}

// The first word token with `value` at parenthesis depth 0 at or after `i`.
function hasTopLevelWord(tokens: Token[], i: number, value: string): boolean {
  let depth = 0
  for (; i < tokens.length; i++) {
    const t = tokens[i]!
    if (t.type === 'punct') {
      if (t.value === '(') depth++
      else if (t.value === ')') depth = Math.max(0, depth - 1)
      continue
    }
    if (depth === 0 && t.type === 'word' && t.value === value) return true
  }
  return false
}

// A row-locking read (`FOR UPDATE` / `FOR SHARE` / `FOR NO KEY UPDATE` …) cannot be wrapped in a
// subquery, so callers cap its output after the fact instead.
function hasTopLevelLock(tokens: Token[]): boolean {
  let depth = 0
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!
    if (t.type === 'punct') {
      if (t.value === '(') depth++
      else if (t.value === ')') depth = Math.max(0, depth - 1)
      continue
    }
    if (depth !== 0 || t.type !== 'word' || t.value !== 'for') continue
    const next = tokens[i + 1]
    if (next?.type === 'word' && ['update', 'share', 'no', 'key'].includes(next.value)) return true
  }
  return false
}

// EXPLAIN only plans, so it reads nothing — except EXPLAIN ANALYZE, which executes the statement
// it explains (`EXPLAIN ANALYZE DELETE …` deletes). Both the `EXPLAIN ANALYZE …` and the
// `EXPLAIN (ANALYZE, …) …` forms are handled; anything unparseable fails closed as a write.
function classifyExplain(tokens: Token[], dialect: SqlDialect): SqlClass {
  let i = 1
  let analyzed = false
  const next = tokens[i]
  if (next?.type === 'word' && (next.value === 'analyze' || next.value === 'analyse')) {
    analyzed = true
    i++
  } else if (next?.type === 'punct' && next.value === '(') {
    const close = skipBalanced(tokens, i) - 1
    analyzed = tokens
      .slice(i + 1, close)
      .some((t) => t.type === 'word' && (t.value === 'analyze' || t.value === 'analyse'))
    i = close + 1
  }
  if (!analyzed) return 'read'
  const inner = tokens.slice(i)
  if (inner.length === 0) return 'write'
  return classifyStatement(inner, dialect)
}

// A WITH statement classifies as the class of its main statement, raised to `write` when any CTE
// body modifies data: `WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d` deletes rows even
// though the main statement is a plain SELECT.
function classifyWith(tokens: Token[], dialect: SqlDialect): SqlClass {
  const stripped = stripCte(tokens)
  if ('fail' in stripped) return 'write'
  if (stripped.main.length === 0) return 'write'
  const main = classifyStatement(stripped.main, dialect)
  if (main === 'read' && cteBodyWrites(tokens)) return 'write'
  return main
}

function classifyStatement(tokens: Token[], dialect: SqlDialect): SqlClass {
  const first = tokens[0]
  if (first?.type !== 'word') return 'write'

  switch (first.value) {
    case 'select':
      // PostgreSQL's `SELECT … INTO new_table` creates (and fills) a table: a write, not a read.
      if (dialect === 'postgres' && hasTopLevelWord(tokens, 1, 'into')) return 'write'
      return 'read'

    case 'values':
      return 'read'

    case 'explain':
      return classifyExplain(tokens, dialect)

    // SHOW is introspection on PostgreSQL; on SQLite it only reaches here unrecognised.
    case 'show':
      return dialect === 'postgres' ? 'read' : 'write'

    case 'with':
      return classifyWith(tokens, dialect)

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
      return FILE_STATEMENTS.has(first.value) ? 'forbidden' : 'write'
  }
}

export function classifySql(sql: string, dialect: SqlDialect = 'sqlite'): SqlClass {
  const statements: Token[][] = [[]]
  for (const t of tokenize(sql, dialect)) {
    if (t.type === 'punct' && t.value === ';') statements.push([])
    else statements[statements.length - 1]!.push(t)
  }
  const nonEmpty = statements.filter((s) => s.length > 0)
  if (nonEmpty.length === 0) return 'empty'
  if (nonEmpty.length > 1) return 'multiple'
  return classifyStatement(nonEmpty[0]!, dialect)
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
// produces. EXPLAIN, PRAGMA and SHOW cannot be wrapped; callers cap their (small) output afterwards.
const WRAPPABLE_READS = new Set(['select', 'values', 'with'])

// Rewrites a read statement as `SELECT * FROM (<sql>) LIMIT maxRows + 1`, so the database stops
// after one row more than the caller keeps (that extra row tells it the result was cut off). A
// LIMIT/OFFSET, ORDER BY or WITH inside the statement keeps its meaning in the subquery. Returns
// null for reads that cannot be wrapped. Only call it for SQL that classifySql() rated 'read' and
// that passed checkSqlAccess(): a statement with a second `;`-separated statement never gets here.
export function limitReadSql(sql: string, maxRows: number, dialect: SqlDialect = 'sqlite'): string | null {
  const { tokens } = scan(sql, dialect)
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
  // PostgreSQL cannot wrap a row-locking read in a subquery; its output is capped afterwards.
  if (dialect === 'postgres' && hasTopLevelLock(tokens)) return null
  // A single statement can only have a `;` at its end: drop it so the statement fits in parentheses
  const semicolon = tokens.find((t) => t.type === 'punct' && t.value === ';')
  let body = semicolon ? sql.slice(0, semicolon.start) : sql
  // Close a trailing /* comment, and end a trailing -- comment with the newline, so neither can
  // swallow the closing parenthesis
  if (scan(body, dialect).openComment) body += '*/'
  // PostgreSQL versions before 16 require an alias on a FROM subquery.
  const alias = dialect === 'postgres' ? ' AS zeta_limit' : ''
  return `SELECT * FROM (\n${body}\n)${alias} LIMIT ${maxRows + 1}`
}
