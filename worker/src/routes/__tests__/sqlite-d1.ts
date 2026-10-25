import { DatabaseSync, type StatementSync } from 'node:sqlite'
import type { D1Database } from '@cloudflare/workers-types'

type Row = Record<string, unknown>

// A D1 binding backed by a real in-memory SQLite database (node:sqlite), for tests that depend on
// actual SQL semantics such as foreign keys. Like D1, foreign keys are enforced and batch() runs
// in a single transaction that is rolled back if any statement fails. `sqlite` gives tests direct
// access for seeding and inspecting the schema.
export function sqliteD1() {
  const sqlite = new DatabaseSync(':memory:')
  sqlite.exec('PRAGMA foreign_keys = ON')

  const exec = (sql: string, args: unknown[]) => {
    const stmt: StatementSync = sqlite.prepare(sql)
    if (stmt.columns().length > 0) return { results: stmt.all(...args) as Row[], meta: { changes: 0 } }
    const res = stmt.run(...args)
    return { results: [] as Row[], meta: { changes: Number(res.changes), last_row_id: Number(res.lastInsertRowid) } }
  }

  const statement = (sql: string, args: unknown[] = []) => ({
    sql,
    args,
    bind: (...next: unknown[]) => statement(sql, next),
    first: async (column?: string) => {
      const row = exec(sql, args).results[0]
      if (!row) return null
      return column === undefined ? row : (row[column] ?? null)
    },
    all: async () => exec(sql, args),
    run: async () => exec(sql, args),
  })

  const db = {
    prepare: (sql: string) => statement(sql),
    batch: async (stmts: Array<ReturnType<typeof statement>>) => {
      sqlite.exec('BEGIN')
      try {
        const results = stmts.map((s) => exec(s.sql, s.args))
        sqlite.exec('COMMIT')
        return results
      } catch (err) {
        sqlite.exec('ROLLBACK')
        throw err
      }
    },
    // D1's multi-statement exec(): runs the whole string, throwing on the first bad statement.
    exec: async (sql: string) => {
      sqlite.exec(sql)
      return { count: 0, duration: 0 }
    },
  }
  return { db: db as unknown as D1Database, sqlite }
}
