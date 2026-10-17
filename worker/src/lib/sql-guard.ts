export type SqlClass = 'read' | 'write' | 'destructive' | 'forbidden' | 'multiple' | 'empty'
export type Permission = 'read' | 'write' | 'write_drop'

interface Token {
  type: 'word' | 'quoted' | 'punct'
  value: string
}

// Comments are dropped and quoted strings/identifiers become opaque tokens, so
// keywords or parentheses hidden inside them can never influence classification.
function tokenize(sql: string): Token[] {
  const tokens: Token[] = []
  const n = sql.length
  let i = 0
  while (i < n) {
    const ch = sql[i]!
    if (/\s/.test(ch)) {
      i++
    } else if (ch === '-' && sql[i + 1] === '-') {
      while (i < n && sql[i] !== '\n') i++
    } else if (ch === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2)
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
      tokens.push({ type: 'quoted', value: '' })
    } else if (ch === '[') {
      const end = sql.indexOf(']', i + 1)
      i = end === -1 ? n : end + 1
      tokens.push({ type: 'quoted', value: '' })
    } else if (/[A-Za-z0-9_$\u0080-￿]/.test(ch)) {
      const start = i
      while (i < n && /[A-Za-z0-9_$\u0080-￿]/.test(sql[i]!)) i++
      tokens.push({ type: 'word', value: sql.slice(start, i).toLowerCase() })
    } else {
      tokens.push({ type: 'punct', value: ch })
      i++
    }
  }
  return tokens
}

const READ_PRAGMAS = new Set([
  'table_info', 'table_xinfo', 'table_list', 'index_list', 'index_info', 'index_xinfo',
  'foreign_key_list', 'foreign_key_check', 'database_list', 'collation_list',
  'function_list', 'module_list', 'pragma_list', 'compile_options',
  'integrity_check', 'quick_check',
])

const CTE_WRITE_KEYWORDS = new Set(['insert', 'update', 'delete', 'replace'])

function classifyStatement(tokens: Token[]): SqlClass {
  const first = tokens[0]
  if (!first || first.type !== 'word') return 'write'

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
