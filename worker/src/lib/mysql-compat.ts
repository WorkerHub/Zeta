// MySQL compatibility layer: rewrites a small set of MySQL introspection statements
// (SHOW TABLES, DESCRIBE, SHOW CREATE TABLE, SHOW INDEX) into equivalent read-only SQLite
// queries, so D1 users can run them. Everything else is left untouched for the normal
// classification / execution path.
//
// The rewritten statements are always plain SELECTs over `sqlite_master` and the
// `pragma_*` table-valued functions, so they stay read-only and are still capped by
// `limitReadSql`. A table name is embedded as an escaped single-quoted string literal,
// never concatenated raw, so it cannot inject SQL.
//
// `SHOW DATABASES` is recognised but reported as unsupported: D1 connects to a single
// database at a time, so there is no list to return.

export type MySqlResult = { type: 'sql'; sql: string } | { type: 'error'; message: string } | null

type Token = { kind: 'word' | 'quoted' | 'punct'; value: string }

// A tiny lexer matching the identifier rules used by sql-guard. Quoted identifiers
// (backtick or double quote, each with doubled-quote escapes) yield their unquoted
// value; everything else that is not a word character becomes a single punctuation token.
function lex(sql: string): Token[] {
  const tokens: Token[] = []
  const n = sql.length
  let i = 0
  while (i < n) {
    const ch = sql[i]!
    if (/\s/.test(ch)) {
      i++
    } else if (ch === '`' || ch === '"') {
      const quote = ch
      i++
      let value = ''
      while (i < n) {
        if (sql[i] === quote) {
          if (sql[i + 1] === quote) {
            value += quote
            i += 2
          } else {
            i++
            break
          }
        } else {
          value += sql[i]!
          i++
        }
      }
      tokens.push({ kind: 'quoted', value })
    } else if (/[A-Za-z0-9_$\u0080-\uFFFF]/.test(ch)) {
      const start = i
      while (i < n && /[A-Za-z0-9_$\u0080-\uFFFF]/.test(sql[i]!)) i++
      tokens.push({ kind: 'word', value: sql.slice(start, i) })
    } else {
      tokens.push({ kind: 'punct', value: ch })
      i++
    }
  }
  return tokens
}

// The statement is fully matched only when it ends after `idx` (nothing, or one trailing `;`).
function expectEnd(tokens: Token[], idx: number): boolean {
  if (idx >= tokens.length) return true
  return idx === tokens.length - 1 && tokens[idx]!.kind === 'punct' && tokens[idx]!.value === ';'
}

// Reads a table name token: unquoted, backtick-quoted or double-quoted. Single-quoted
// names and symbols are not MySQL table syntax here, so they fall through.
function readTable(tokens: Token[], idx: number): { name: string; next: number } | null {
  const t = tokens[idx]
  if (!t) return null
  if (t.kind !== 'quoted' && t.kind !== 'word') return null
  return { name: t.value, next: idx + 1 }
}

// Reads `FROM <tbl>` or `IN <tbl>` starting at `idx`.
function readTableAfterFrom(tokens: Token[], idx: number): { name: string; next: number } | null {
  const kw = tokens[idx]
  if (kw?.kind !== 'word') return null
  const v = kw.value.toLowerCase()
  if (v !== 'from' && v !== 'in') return null
  return readTable(tokens, idx + 1)
}

function sqlLiteral(s: string): string {
  return `'${s.replace(/'/g, "''")}'`
}

function showTablesSql(): string {
  return [
    'SELECT name',
    'FROM sqlite_master',
    "WHERE type IN ('table', 'view')",
    "AND substr(name, 1, 7) <> 'sqlite_'",
    "AND substr(name, 1, 4) <> '_cf_'",
    'ORDER BY name',
  ].join('\n')
}

function describeSql(table: string): string {
  const t = sqlLiteral(table)
  return [
    'SELECT',
    '  p.name AS "Field",',
    '  p.type AS "Type",',
    '  CASE WHEN p."notnull" THEN \'NO\' ELSE \'YES\' END AS "Null",',
    "  CASE WHEN p.pk > 0 THEN 'PRI' ELSE '' END AS \"Key\",",
    '  p.dflt_value AS "Default",',
    '  \'\' AS "Extra"',
    `FROM pragma_table_info(${t}) AS p`,
    'ORDER BY p.cid',
  ].join('\n')
}

function showCreateSql(table: string): string {
  const t = sqlLiteral(table)
  return [
    'SELECT name AS "Table", sql AS "Create Table"',
    'FROM sqlite_master',
    `WHERE type = 'table' AND name = ${t}`,
  ].join('\n')
}

function showIndexSql(table: string): string {
  const t = sqlLiteral(table)
  return [
    'SELECT',
    `  ${t} AS "Table",`,
    '  CASE WHEN il."unique" THEN 0 ELSE 1 END AS "Non_unique",',
    "  CASE WHEN il.origin = 'pk' THEN 'PRIMARY' ELSE il.name END AS \"Key_name\",",
    '  (ii.seqno + 1) AS "Seq_in_index",',
    '  ii.name AS "Column_name",',
    '  \'A\' AS "Collation",',
    '  NULL AS "Cardinality",',
    '  NULL AS "Sub_part",',
    '  NULL AS "Packed",',
    '  CASE WHEN p."notnull" THEN \'\' ELSE \'YES\' END AS "Null",',
    '  \'BTREE\' AS "Index_type",',
    '  \'\' AS "Comment",',
    '  \'\' AS "Index_comment",',
    '  \'YES\' AS "Visible",',
    '  NULL AS "Expression"',
    `FROM pragma_index_list(${t}) AS il`,
    'JOIN pragma_index_info(il.name) AS ii',
    `LEFT JOIN pragma_table_info(${t}) AS p ON p.cid = ii.cid`,
    "ORDER BY CASE WHEN il.origin = 'pk' THEN 0 ELSE 1 END, il.name, ii.seqno",
  ].join('\n')
}

function translateShow(tokens: Token[]): MySqlResult {
  const first = tokens[0]
  if (first?.kind !== 'word') return null
  switch (first.value.toLowerCase()) {
    case 'tables':
      return expectEnd(tokens, 1) ? { type: 'sql', sql: showTablesSql() } : null
    case 'databases':
      return expectEnd(tokens, 1)
        ? { type: 'error', message: 'SHOW DATABASES is not supported: each connection is bound to a single database.' }
        : null
    case 'columns': {
      const table = readTableAfterFrom(tokens, 1)
      if (!table || !expectEnd(tokens, table.next)) return null
      return { type: 'sql', sql: describeSql(table.name) }
    }
    case 'create': {
      const kw = tokens[1]
      if (kw?.kind !== 'word' || kw.value.toLowerCase() !== 'table') return null
      const table = readTable(tokens, 2)
      if (!table || !expectEnd(tokens, table.next)) return null
      return { type: 'sql', sql: showCreateSql(table.name) }
    }
    case 'index':
    case 'indexes':
    case 'keys': {
      const table = readTableAfterFrom(tokens, 1)
      if (!table || !expectEnd(tokens, table.next)) return null
      return { type: 'sql', sql: showIndexSql(table.name) }
    }
    default:
      return null
  }
}

function translateDescribe(tokens: Token[]): MySqlResult {
  const table = readTable(tokens, 0)
  if (!table || !expectEnd(tokens, table.next)) return null
  return { type: 'sql', sql: describeSql(table.name) }
}

export function translateMySql(input: string): MySqlResult {
  const sql = input.trim()
  if (!sql) return null
  const tokens = lex(sql)
  const first = tokens[0]
  if (first?.kind !== 'word') return null
  const keyword = first.value.toLowerCase()

  if (keyword === 'show') return translateShow(tokens.slice(1))
  if (keyword === 'describe' || keyword === 'desc') return translateDescribe(tokens.slice(1))
  return null
}
