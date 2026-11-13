import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { queryApi } from '../lib/api'
import {
  addConnected,
  readConnected,
  readSessionDatabases,
  removeConnected,
  setSessionDatabase,
  withoutSessionDatabase,
  writeConnected,
  writeSessionDatabases,
} from '../lib/connection-state'
import type { SessionDatabases } from '../lib/connection-state'

export type ConnectResult = { ok: true } | { ok: false; error: unknown }

/**
 * The connect button's state for the query page: which targets this browser session has proven
 * reachable, plus one probe in flight at a time.
 *
 * Nothing here is a server-side session — the probe only runs `select 1` and the answer is stored in
 * the tab (lib/connection-state.ts). Disconnecting, and knocking a target back when a query says it
 * is no longer reachable, both happen here and nowhere else.
 */
export function useConnections(knownIds: string[]) {
  const [connected, setConnected] = useState<string[]>(() => readConnected())
  // The database each MySQL target's shared session is currently pointed at (lib/connection-state.ts)
  const [sessionDatabases, setSessionDatabases] = useState<SessionDatabases>(() => readSessionDatabases())
  const [busyId, setBusyId] = useState<string | null>(null)
  // Guards a second probe started before the disabled button re-renders
  const busyRef = useRef<string | null>(null)

  // Every change is written back, so a reload inside the same tab finds its connections again
  useEffect(() => {
    writeConnected(connected)
  }, [connected])

  useEffect(() => {
    writeSessionDatabases(sessionDatabases)
  }, [sessionDatabases])

  // Targets the page no longer lists (deleted, deactivated, access revoked) are dropped once the
  // list arrives, so a stale id can never look connected. An empty list means "not loaded yet" —
  // pruning then would wipe the session's state before the server answered. A target's remembered
  // session database goes with its connection: both describe a target this tab was talking to.
  const known = useMemo(() => new Set(knownIds), [knownIds])
  useEffect(() => {
    if (known.size === 0) return
    setConnected((current) => {
      const next = current.filter((id) => known.has(id))
      return next.length === current.length ? current : next
    })
    setSessionDatabases((current) => {
      const stale = Object.keys(current).filter((id) => !known.has(id))
      return stale.reduce((map, id) => withoutSessionDatabase(map, id), current)
    })
  }, [known])

  const isConnected = useCallback((id: string) => connected.includes(id), [connected])

  // Resolves ok when the target answered; the raw error otherwise, for the page to turn into copy
  // (only Spark failures carry a code the UI can translate).
  const connect = useCallback(async (id: string): Promise<ConnectResult> => {
    if (busyRef.current !== null) return { ok: true }
    busyRef.current = id
    setBusyId(id)
    try {
      await queryApi.probe(id)
      setConnected((current) => addConnected(current, id))
      return { ok: true }
    } catch (error) {
      return { ok: false, error }
    } finally {
      busyRef.current = null
      setBusyId(null)
    }
  }, [])

  const disconnect = useCallback((id: string) => {
    setConnected((current) => removeConnected(current, id))
    setSessionDatabases((current) => withoutSessionDatabase(current, id))
  }, [])

  // What the page sends with a MySQL query: the database the target's session is on, or null for
  // the registered database (no field at all)
  const sessionDatabaseOf = useCallback(
    (id: string) => (id in sessionDatabases ? sessionDatabases[id]! : null),
    [sessionDatabases]
  )

  const rememberSessionDatabase = useCallback((id: string, name: string) => {
    setSessionDatabases((current) => setSessionDatabase(current, id, name))
  }, [])

  // The remembered database turned out not to exist: forget it, but keep the connection — the target
  // itself answered, just not the database this tab had picked
  const forgetSessionDatabase = useCallback((id: string) => {
    setSessionDatabases((current) => withoutSessionDatabase(current, id))
  }, [])

  // A query that fails for an auth/transport/not-ready reason means the target is not reachable
  // any more: the next click has to prove it again.
  return {
    isConnected,
    busyId,
    connect,
    disconnect,
    knockBack: disconnect,
    sessionDatabaseOf,
    rememberSessionDatabase,
    forgetSessionDatabase,
  }
}
