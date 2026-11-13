import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { queryApi } from '../lib/api'
import { addConnected, readConnected, removeConnected, writeConnected } from '../lib/connection-state'

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
  const [busyId, setBusyId] = useState<string | null>(null)
  // Guards a second probe started before the disabled button re-renders
  const busyRef = useRef<string | null>(null)

  // Every change is written back, so a reload inside the same tab finds its connections again
  useEffect(() => {
    writeConnected(connected)
  }, [connected])

  // Targets the page no longer lists (deleted, deactivated, access revoked) are dropped once the
  // list arrives, so a stale id can never look connected.
  const known = useMemo(() => new Set(knownIds), [knownIds])
  useEffect(() => {
    setConnected((current) => {
      const next = current.filter((id) => known.has(id))
      return next.length === current.length ? current : next
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
  }, [])

  // A query that fails for an auth/transport/not-ready reason means the target is not reachable
  // any more: the next click has to prove it again.
  return { isConnected, busyId, connect, disconnect, knockBack: disconnect }
}
