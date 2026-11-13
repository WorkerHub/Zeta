// Which query targets this browser session has proven reachable.
//
// A "connection" is a per-target fact that only means "this target answered a probe", never a
// server-side session: it is kept in the tab's sessionStorage and is forgotten when the session
// ends. Every value here is a database id, so two notebooks pointing at the same target share it.

export const CONNECTED_KEY = 'zeta:connected-targets'

// A failure that says the target itself is no longer usable — the worker reports auth, transport
// and "not ready" failures as 5xx, SQL errors as 4xx — puts the target back to not connected. A
// rejected statement says nothing about reachability, so it leaves the connection alone.
export function knocksBack(status: number | undefined): boolean {
  return typeof status === 'number' && status >= 500
}

// Whatever is in storage is not trusted: it may be from another version of the page, edited by
// hand, or truncated by the browser. Only non-empty strings survive, duplicates collapse.
export function parseConnected(raw: string | null): string[] {
  if (!raw) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  return [...new Set(parsed.filter((id): id is string => typeof id === 'string' && id !== ''))]
}

export function serializeConnected(ids: string[]): string {
  return JSON.stringify(ids)
}

export function addConnected(ids: string[], id: string): string[] {
  return ids.includes(id) ? ids : [...ids, id]
}

export function removeConnected(ids: string[], id: string): string[] {
  return ids.filter((current) => current !== id)
}

// Storage is best-effort: a browser that denies it (privacy mode, embedded webview) must not take
// the query page down with it — the connection just does not survive a reload there.
function sessionStore(): Storage | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage
  } catch {
    return null
  }
}

export function readConnected(): string[] {
  try {
    return parseConnected(sessionStore()?.getItem(CONNECTED_KEY) ?? null)
  } catch {
    return []
  }
}

export function writeConnected(ids: string[]): void {
  try {
    sessionStore()?.setItem(CONNECTED_KEY, serializeConnected(ids))
  } catch {
    // Nothing to do: the in-memory state still works for this page view.
  }
}

// ── The MySQL session's current database ──────────────────────────────────────

// A TiDB Cloud Starter endpoint hands every request the same server-side session per credentials,
// so a `USE` in one run would decide where the next run lands. The worker re-pins the session before
// each request — to the registered database, or to this value when the request carries it — which
// makes "the current database" a per-target fact like the connection state, kept in the same tab
// and with the same lifetime: forgetting a target's connection forgets where its session pointed,
// and its next run starts from the registered database again. A target with no entry is on its
// registered database, so the page never needs to know the name inside the connection string.
export const SESSION_DATABASE_KEY = 'zeta:mysql-session-db'

/** Database name per target id. */
export type SessionDatabases = Record<string, string>

// Untrusted like the connected list: only non-empty string pairs survive.
export function parseSessionDatabases(raw: string | null): SessionDatabases {
  if (!raw) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return {}
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
  const databases: SessionDatabases = {}
  for (const [id, name] of Object.entries(parsed as Record<string, unknown>)) {
    if (id !== '' && typeof name === 'string' && name !== '') databases[id] = name
  }
  return databases
}

export function serializeSessionDatabases(databases: SessionDatabases): string {
  return JSON.stringify(databases)
}

// Neither helper mutates what it is given: both feed React state.
export function setSessionDatabase(databases: SessionDatabases, id: string, name: string): SessionDatabases {
  return databases[id] === name ? databases : { ...databases, [id]: name }
}

export function withoutSessionDatabase(databases: SessionDatabases, id: string): SessionDatabases {
  if (!(id in databases)) return databases
  const rest = { ...databases }
  delete rest[id]
  return rest
}

export function readSessionDatabases(): SessionDatabases {
  try {
    return parseSessionDatabases(sessionStore()?.getItem(SESSION_DATABASE_KEY) ?? null)
  } catch {
    return {}
  }
}

export function writeSessionDatabases(databases: SessionDatabases): void {
  try {
    sessionStore()?.setItem(SESSION_DATABASE_KEY, serializeSessionDatabases(databases))
  } catch {
    // Nothing to do: the in-memory state still works for this page view.
  }
}
