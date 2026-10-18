import type { Env, DatabaseRow } from '../types'
import { appDbId } from './d1-http'

// A registered database is always executed over the D1 HTTP API. The legacy binding path was
// removed once every database had been re-linked to a Cloudflare database.
export type QueryTarget = { kind: 'http'; databaseId: string }

export type QueryTargetResult = { ok: true; target: QueryTarget } | { ok: false; error: string }

// Resolves a registered database row to its execution target. A row must carry a cf_database_id:
// it runs over the HTTP API (and the application's own database is refused). Rows without one were
// registered by the old binding method and must be re-linked in Admin → Databases. The app-DB
// exclusion fails closed: without ZETA_APP_DB_ID configured the HTTP path cannot prove a database
// is not the app DB, so it refuses to run.
export function resolveQueryTarget(env: Env, db: DatabaseRow): QueryTargetResult {
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
  if (db.cf_database_id === appId) {
    return { ok: false, error: 'This database is the application database and cannot be queried.' }
  }
  return { ok: true, target: { kind: 'http', databaseId: db.cf_database_id } }
}
