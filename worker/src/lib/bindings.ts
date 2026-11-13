import type { DatabaseRow, Env } from '../types'
import { appDbId, appDbTargetAllowed, isAppDb } from './d1-http'

// How a registered database is executed. `http` is the D1 HTTP API (SQLite); `postgres` runs over
// a PostgreSQL wire connection opened for the request (see lib/pg-executor.ts).
export type QueryTarget = { kind: 'http'; databaseId: string } | { kind: 'postgres'; databaseId: string }

export type QueryTargetResult = { ok: true; target: QueryTarget } | { ok: false; error: string }

// Resolves a registered database row to its execution target, by the row's engine.
//
//   * `postgres` — needs a stored connection; the URL itself is decrypted where the executor is
//     opened (lib/pg-executor.ts), never here or in an API response.
//   * `sqlite` (and rows created before the `kind` column existed) — the D1 HTTP API. The row must
//     carry a cf_database_id. The application's own database is refused unless
//     ALLOW_APP_DB_AS_TARGET is enabled (shared-database deployments; the app-DB guardrails in
//     lib/app-db-guard.ts then apply on the query paths). Rows without one were registered by the
//     old binding method and must be re-linked in Admin → Databases. The app-DB exclusion fails
//     closed: without ZETA_APP_DB_ID configured the HTTP path cannot prove a database is not the app
//     DB, so it refuses to run — even with the switch on.
export function resolveQueryTarget(env: Env, db: DatabaseRow): QueryTargetResult {
  if (db.kind === 'postgres') {
    if (!db.connection_secret) {
      return {
        ok: false,
        error: 'This database has no stored connection. Save it again in Admin → Databases.',
      }
    }
    return { ok: true, target: { kind: 'postgres', databaseId: db.id } }
  }

  if (!db.cf_database_id) {
    return {
      ok: false,
      error: 'This database is not linked to a Cloudflare database yet. Link it in Admin → Databases.',
    }
  }
  const appId = appDbId(env)
  if (!appId) {
    return { ok: false, error: 'ZETA_APP_DB_ID is not configured on this Worker.' }
  }
  if (isAppDb(env, db.cf_database_id) && !appDbTargetAllowed(env)) {
    return { ok: false, error: 'This database is the application database and cannot be queried.' }
  }
  return { ok: true, target: { kind: 'http', databaseId: db.cf_database_id } }
}
