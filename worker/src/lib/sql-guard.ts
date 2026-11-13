export type SqlClass = 'read' | 'write' | 'destructive' | 'forbidden' | 'multiple' | 'empty'
export type Permission = 'read' | 'write' | 'write_drop'
export type SqlDialect = 'sqlite' | 'postgres' | 'mysql'

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
//
// The mysql dialect differs in three places, all of them in the dangerous direction (we would treat
// as a comment/inside-a-string what the server executes as SQL):
//   * `/*! … */` is an executable comment — it is reported as `executableComment`, never dropped,
//   * `#` starts a comment that runs to the end of the line,
//   * backslash escapes inside '…' and "…" (MySQL's default sql_mode), so \' does not close the string.
function scan(sql: string, dialect: SqlDialect): { tokens: Token[]; openComment: boolean; executableComment: boolean } {
  const tokens: Token[] = []
  let openComment = false
  let executableComment = false
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
    } else if (dialect === 'mysql' && ch === '#') {
      while (i < n && sql[i] !== '\n') i++
    } else if (ch === '/' && sql[i + 1] === '*') {
      // MySQL executes the body of `/*! … */`; `/*+ … */` is a plain optimizer hint and is dropped.
      if (dialect === 'mysql' && sql[i + 2] === '!') executableComment = true
      const end = sql.indexOf('*/', i + 2)
      if (end === -1) openComment = true
      i = end === -1 ? n : end + 2
    } else if (dialect === 'mysql' && ch !== '`' && (ch === "'" || ch === '"')) {
      i++
      while (i < n) {
        if (sql[i] === '\\') {
          i += 2
        } else if (sql[i] === ch) {
          if (sql[i + 1] === ch) i += 2
          else break
        } else i++
      }
      i++
      tokens.push({ type: 'quoted', value: '', start })
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
    } else if (ch === '[' && dialect !== 'mysql') {
      // SQLite (and T-SQL) bracket quoting; MySQL has no such form, so a `[` there must stay visible
      // to the tokenizer — otherwise an unterminated `[` could hide a `;` from the multi-statement check.
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
  return { tokens, openComment, executableComment }
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

// MySQL statements that name no data but change the connection, the server or the caller's
// privileges. `CREATE USER/ROLE` is caught separately (it starts with `create`).
//
// Live re-check (2026-11-13, plan §10-7): the endpoint keeps **one** session per set of credentials,
// shared by every request of the app (same `CONNECTION_ID` from a fresh process, `SET @x` and `USE`
// both visible to the next request). `USE`/`SET` therefore do work — and would silently rewrite the
// session for every other user's query, which is worse than the earlier "they do nothing" reading.
// `BEGIN` is MySQL's synonym of the already-forbidden `START TRANSACTION`: an open transaction in the
// shared session would capture other requests' statements.
const MYSQL_FORBIDDEN_KEYWORDS = new Set([
  'lock',
  'unlock',
  'prepare',
  'execute',
  'deallocate',
  'grant',
  'revoke',
  'flush',
  'kill',
  'shutdown',
  'start',
  'begin',
  'commit',
  'rollback',
  'savepoint',
  'use',
  'set',
  'handler',
])

// `SHOW` variants that leak other sessions' SQL or the server's grants to any member with read
// access. Everything else SHOW returns (`TABLES`, `CREATE`, `INDEX`, `VARIABLES`, `COLUMNS`, …) is
// introspection and read-only.
const MYSQL_FORBIDDEN_SHOW = new Set(['processlist', 'grants'])

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

// MySQL's other row-locking form, `LOCK IN SHARE MODE`, plus `FOR UPDATE`/`FOR SHARE`.
function hasMySqlTopLevelLock(tokens: Token[]): boolean {
  return hasTopLevelLock(tokens) || hasTopLevelWord(tokens, 1, 'lock')
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

  if (dialect === 'mysql' && MYSQL_FORBIDDEN_KEYWORDS.has(first.value)) return 'forbidden'

  switch (first.value) {
    case 'select':
      // PostgreSQL's `SELECT … INTO new_table` creates (and fills) a table: a write, not a read.
      if (dialect === 'postgres' && hasTopLevelWord(tokens, 1, 'into')) return 'write'
      // MySQL/PostgreSQL `SELECT … INTO OUTFILE/DUMPFILE` writes a server-side file.
      if (dialect === 'mysql' && (hasTopLevelWord(tokens, 1, 'outfile') || hasTopLevelWord(tokens, 1, 'dumpfile'))) {
        return 'forbidden'
      }
      return 'read'

    case 'values':
      return 'read'

    case 'explain':
      return classifyExplain(tokens, dialect)

    // SHOW is introspection on PostgreSQL and MySQL; on SQLite it only reaches here unrecognised.
    case 'show': {
      if (dialect === 'sqlite') return 'write'
      if (dialect === 'mysql') {
        const target = tokens[1]?.type === 'word' && tokens[1]!.value === 'full' ? tokens[2] : tokens[1]
        if (target?.type === 'word' && MYSQL_FORBIDDEN_SHOW.has(target.value)) return 'forbidden'
      }
      return 'read'
    }

    case 'describe':
    case 'desc':
      // MySQL table introspection (`DESCRIBE t` / `DESC t`) is a read; nowhere else is it SQL we run.
      return dialect === 'mysql' ? 'read' : 'write'

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

    case 'create':
      // MySQL's `CREATE USER`/`CREATE ROLE` grants access to the server itself, not a table.
      if (dialect === 'mysql' && (tokens[1]?.value === 'user' || tokens[1]?.value === 'role')) return 'forbidden'
      return 'write'

    default:
      return FILE_STATEMENTS.has(first.value) ? 'forbidden' : 'write'
  }
}

export function classifySql(sql: string, dialect: SqlDialect = 'sqlite'): SqlClass {
  const { tokens: all, executableComment } = scan(sql, dialect)
  // MySQL executes `/*! … */`; a statement carrying one is refused outright rather than partial.
  if (dialect === 'mysql' && executableComment) return 'forbidden'
  const statements: Token[][] = [[]]
  for (const t of all) {
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
  // PostgreSQL and MySQL both refuse a row-locking read inside a subquery; its output is capped
  // afterwards instead (MySQL's extra form: `LOCK IN SHARE MODE`).
  if (dialect === 'postgres' && hasTopLevelLock(tokens)) return null
  if (dialect === 'mysql' && hasMySqlTopLevelLock(tokens)) return null
  // A single statement can only have a `;` at its end: drop it so the statement fits in parentheses
  const semicolon = tokens.find((t) => t.type === 'punct' && t.value === ';')
  let body = semicolon ? sql.slice(0, semicolon.start) : sql
  // Close a trailing /* comment, and end a trailing -- comment with the newline, so neither can
  // swallow the closing parenthesis
  if (scan(body, dialect).openComment) body += '*/'
  // PostgreSQL before 16 and every MySQL require an alias on a FROM subquery.
  const alias = dialect === 'sqlite' ? '' : ' AS zeta_limit'
  return `SELECT * FROM (\n${body}\n)${alias} LIMIT ${maxRows + 1}`
}
