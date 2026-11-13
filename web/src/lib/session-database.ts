import { usedDatabaseOf } from './sql'

// Telling a lost session database apart from a rejected statement.
//
// MySQL's endpoint keeps one server-side session per credentials, so every request pins it first —
// to the database this tab remembered, or to the registration's own. A pin at a database that no
// longer exists fails, and the ruling asks for that to be reported as a deployment error; the worker
// currently passes the engine's own sentence through instead
// (`Execute SQL fail: Error 1049 (42000): Unknown database 'x'`), with no code to key on. Without a
// reaction the page would keep sending the same dead name and every run would fail the same way, so
// the failure's wording is the one signal there is.
//
// A `USE` the user typed is *not* that failure even though it reads the same: it ran after a
// successful pin, and a rejected USE changes nothing. Only a pin failure may forget the remembered
// database.

const UNKNOWN_DATABASE = /Error 1049 \(42000\)|Unknown database/i

/** Whether a worker message says the database does not exist (MySQL error 1049). */
export function namesUnknownDatabase(message: string): boolean {
  return UNKNOWN_DATABASE.test(message)
}

/**
 * Whether a failed run means the remembered session database is gone and the tab should forget it.
 * `statement` is the statement of a single-statement run; a batch passes none, because its failures
 * are per statement and a request-level failure can only be the pin.
 */
export function missingSessionDatabase(args: { statement?: string; message: string }): boolean {
  if (!namesUnknownDatabase(args.message)) return false
  return args.statement === undefined || usedDatabaseOf(args.statement) === null
}
