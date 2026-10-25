// The worker is type-checked against Workers types only (no @types/node or vite/client); this
// declares what the tests use from Node and Vite.

declare module 'node:sqlite' {
  export class StatementSync {
    all(...params: unknown[]): unknown[]
    run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint }
    columns(): unknown[]
  }
  export class DatabaseSync {
    constructor(path: string)
    exec(sql: string): void
    prepare(sql: string): StatementSync
  }
}
