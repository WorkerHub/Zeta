import type { Env } from '../types'
import { migrationsTable, tables } from './db'
import { type Permission, type Token, tokenize } from './sql-guard'

// ── Guardrails for the application database as a query target ──────────────────
// These checks apply ONLY when the resolved target is the application's own D1
// database (ALLOW_APP_DB_AS_TARGET enabled and cf_database_id === appDbId(env));
// ordinary target databases are untouched. All judgment lives here so the single
// and batch query paths share exactly one implementation.

// The application's internal table set: every table name tables(env) resolves to
// (i.e. it follows the effective TABLE_PREFIX — no hardcoded names or prefixes), plus
// the schema-migration ledger `_<prefix>_schema_migrations`. The ledger is not a
// business table, but it is just as internal: a write to it could make setup skip a
// migration (or replay one), so it gets the same read-only protection.
// SQLite table names are case-insensitive, so the set is lowercase and compared
// against lowercased tokens.
export function appInternalTables(env: Pick<Env, 'TABLE_PREFIX'>): Set<string> {
  return new Set([...Object.values(tables(env)), migrationsTable(env)].map((t) => t.toLowerCase()))
}

// On the application database the effective permission is capped at `write`: the
// admin's implicit write_drop is downgraded there, so destructive statements
// (DROP/TRUNCATE/ALTER…DROP per classifySql) are rejected through the ordinary
// permission check instead of a special case.
export function capAppDbPermission(permission: Permission): Permission {
  return permission === 'write_drop' ? 'write' : permission
}

const INTERNAL_TABLE_MSG =
  'This statement targets an application internal table. Application internal tables are read-only on the application database.'
const UNRESOLVABLE_MSG =
  'The target table of this statement cannot be determined, so it is rejected on the application database.'

// ── Target-table extraction (write-class statements only) ─────────────────────
// Reuses sql-guard's tokenizer: word tokens carry the lowercased identifier,
// quoted tokens (", ', `, [) are opaque — a quoted identifier at the target-table
// position therefore counts as unresolvable and the statement is rejected
// (fail closed), mirroring how classification treats quoted content as opaque.

type TargetResult = { ok: true; table: string } | { ok: false }

// Reads the identifier at tokens[i], allowing one schema qualifier (`main.t` → t).
// Anything else at the position (quoted identifier, punctuation, nothing) is
// unresolvable.
function identAt(tokens: Token[], i: number): TargetResult {
  const t = tokens[i]
  if (t?.type !== 'word') return { ok: false }
  const next = tokens[i + 1]
  if (next?.type === 'punct' && next.value === '.') {
    const qualified = tokens[i + 2]
    return qualified?.type === 'word' ? { ok: true, table: qualified.value } : { ok: false }
  }
  return { ok: true, table: t.value }
}

// Index just past the balanced parenthesis group that starts at tokens[open]
// (a `(`), or tokens.length when it never closes.
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

// Strips a WITH [RECURSIVE] cte [(cols)] AS (body), … prefix and returns the
// tokens of the main statement. `fail` covers everything unparseable, including
// a WITH that ends after its CTE list (no main statement at all).
function stripCte(tokens: Token[]): { main: Token[] } | { fail: true } {
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
    if (tokens[i]?.type !== 'punct' || tokens[i]!.value !== '(') return { fail: true }
    i = skipBalanced(tokens, i) // CTE body
    if (tokens[i]?.type === 'punct' && tokens[i]!.value === ',') {
      i++
      continue // another CTE follows
    }
    return { main: tokens.slice(i) }
  }
}

// Skips an `IF [NOT] EXISTS` clause starting at tokens[i]; `not` is optional only
// for CREATE … IF NOT EXISTS grammar — here both words are required together, so
// a stray `IF` reads as unparseable.
function skipIfNotExists(tokens: Token[], i: number): number | null {
  if (tokens[i]?.type !== 'word' || tokens[i]!.value !== 'if') return i
  if (tokens[i + 1]?.value === 'not' && tokens[i + 2]?.value === 'exists') return i + 3
  return null
}

// The index of the first word token with `value` at or after `i`.
function wordIndex(tokens: Token[], i: number, value: string): number {
  for (let j = i; j < tokens.length; j++) {
    const t = tokens[j]!
    if (t.type === 'word' && t.value === value) return j
  }
  return -1
}

// Extracts the target table of a write-class statement from its tokens. Covers the
// forms classifySql lets through as `write` (or `destructive`): INSERT/REPLACE
// INTO, UPDATE, DELETE FROM, CREATE [TEMP|UNIQUE|VIRTUAL] TABLE/INDEX/TRIGGER and
// ALTER TABLE, with or without a WITH prefix. Everything else with no determinable
// target table (VACUUM, REINDEX, ANALYZE, BEGIN, CREATE VIEW, unknown leading
// tokens, garbage) is unresolvable — callers reject those fail closed.
function writeTarget(tokens: Token[]): TargetResult {
  const first = tokens[0]
  if (first?.type !== 'word') return { ok: false }

  switch (first.value) {
    case 'insert':
    case 'replace': {
      // INSERT [OR <conflict-algorithm>] INTO t — the INTO sits within the first few tokens
      const into = wordIndex(tokens, 1, 'into')
      return into === -1 || into > 4 ? { ok: false } : identAt(tokens, into + 1)
    }
    case 'delete': {
      return tokens[1]?.type === 'word' && tokens[1]!.value === 'from' ? identAt(tokens, 2) : { ok: false }
    }
    case 'update': {
      // UPDATE [OR <conflict-algorithm>] t SET …
      const skipConflict = tokens[1]?.type === 'word' && tokens[1]!.value === 'or' && tokens[2] ? 2 : 0
      return identAt(tokens, 1 + skipConflict)
    }
    case 'alter': {
      return tokens[1]?.type === 'word' && tokens[1]!.value === 'table' ? identAt(tokens, 2) : { ok: false }
    }
    case 'create': {
      let i = 1
      while (tokens[i]?.type === 'word' && ['temp', 'temporary', 'unique', 'virtual'].includes(tokens[i]!.value)) i++
      const kind = tokens[i]
      if (kind?.type !== 'word') return { ok: false }
      i++
      const afterClause = skipIfNotExists(tokens, i)
      if (afterClause === null) return { ok: false }

      if (kind.value === 'table') return identAt(tokens, afterClause)
      if (kind.value === 'index') {
        // CREATE [UNIQUE] INDEX [IF NOT EXISTS] <name> ON <table>
        if (afterClause >= tokens.length) return { ok: false } // missing name
        const on = wordIndex(tokens, afterClause + 1, 'on') // skip the index's name
        return on === -1 ? { ok: false } : identAt(tokens, on + 1)
      }
      // CREATE TRIGGER fails closed like CREATE VIEW: a trigger body (BEGIN … END;) can write
      // any table when the trigger fires, so the attached table is not the statement's only
      // target — a trigger created on a non-internal table could mutate internal tables later.
      // CREATE VIEW (and anything else) has no single target table either.
      return { ok: false }
    }
    default:
      return { ok: false }
  }
}

// The app-DB internal-table guard for one write-class statement. Returns the error
// message when the statement must be rejected — its target table is an application
// internal table, or no target table can be determined (fail closed) — and null
// when the write may run. Only call this for statements classifySql rated `write`
// or `destructive` on the application-database target; reads are unrestricted.
export function appDbWriteTargetError(sql: string, appTables: ReadonlySet<string>): string | null {
  let tokens = tokenize(sql)
  // A single statement can only carry trailing `;`s; drop them all so none can read
  // as a punct token at a name position.
  while (tokens.at(-1)?.type === 'punct' && tokens.at(-1)?.value === ';') tokens = tokens.slice(0, -1)

  if (tokens[0]?.type === 'word' && tokens[0]!.value === 'with') {
    const stripped = stripCte(tokens)
    if ('fail' in stripped) return UNRESOLVABLE_MSG
    tokens = stripped.main
  }

  const target = writeTarget(tokens)
  if (!target.ok) return UNRESOLVABLE_MSG
  return appTables.has(target.table) ? INTERNAL_TABLE_MSG : null
}
