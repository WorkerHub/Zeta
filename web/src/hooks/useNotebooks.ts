import { useState, useEffect, useRef, useCallback } from 'react'
import { notebooksApi } from '../lib/api'
import type { Notebook } from '../types'

const ACTIVE_NOTEBOOK_KEY = 'zeta_active_notebook'
const DEBOUNCE_MS = 1500
const MAX_NOTEBOOKS = 20

export function useNotebooks() {
  const [notebooks, setNotebooks] = useState<Notebook[]>([])
  const [activeId, setActiveIdState] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const debounceTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())
  const notebooksRef = useRef<Notebook[]>([])

  // Keep ref in sync so callbacks can read current notebooks without stale closures
  useEffect(() => {
    notebooksRef.current = notebooks
  }, [notebooks])

  // Flush all pending debounce saves on unmount
  useEffect(() => {
    return () => {
      debounceTimers.current.forEach((timer, id) => {
        clearTimeout(timer)
        const nb = notebooksRef.current.find(n => n.id === id)
        if (nb) notebooksApi.update(id, { sql_content: nb.sql_content }).catch(() => {})
      })
      debounceTimers.current.clear()
    }
  }, [])

  useEffect(() => {
    notebooksApi.list()
      .then(async ({ results }) => {
        let nbs = results
        if (nbs.length === 0) {
          const created = await notebooksApi.create({})
          nbs = [created]
        }
        setNotebooks(nbs)
        const stored = localStorage.getItem(ACTIVE_NOTEBOOK_KEY)
        const validId = stored && nbs.some(n => n.id === stored) ? stored : (nbs[0]?.id ?? null)
        setActiveIdState(validId)
      })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  const setActiveId = useCallback((id: string) => {
    setActiveIdState(id)
    localStorage.setItem(ACTIVE_NOTEBOOK_KEY, id)
  }, [])

  const createNotebook = useCallback(async () => {
    if (notebooksRef.current.length >= MAX_NOTEBOOKS) return
    const nb = await notebooksApi.create({})
    setNotebooks(prev => [...prev, nb])
    setActiveId(nb.id)
  }, [setActiveId])

  const deleteNotebook = useCallback(async (id: string) => {
    const current = notebooksRef.current
    const deletedIdx = current.findIndex(n => n.id === id)
    const remaining = current.filter(n => n.id !== id)

    // Clear any pending debounce before the API call to avoid a 404 race
    const timer = debounceTimers.current.get(id)
    if (timer) { clearTimeout(timer); debounceTimers.current.delete(id) }

    await notebooksApi.delete(id)

    setNotebooks(prev => prev.filter(n => n.id !== id).map((n, i) => ({ ...n, position: i })))

    setActiveIdState(prev => {
      if (prev !== id) return prev
      const next = remaining[Math.max(0, deletedIdx - 1)]
      const newId = next?.id ?? null
      if (newId) localStorage.setItem(ACTIVE_NOTEBOOK_KEY, newId)
      return newId
    })
  }, [])

  const renameNotebook = useCallback(async (id: string, name: string) => {
    const trimmed = name.trim() || 'Untitled'
    const prevName = notebooksRef.current.find(n => n.id === id)?.name ?? null
    setNotebooks(p => p.map(n => n.id === id ? { ...n, name: trimmed } : n))
    try {
      await notebooksApi.update(id, { name: trimmed })
    } catch {
      if (prevName !== null) setNotebooks(p => p.map(n => n.id === id ? { ...n, name: prevName } : n))
    }
  }, [])

  const updateContent = useCallback((id: string, sql_content: string) => {
    setNotebooks(prev => prev.map(n => n.id === id ? { ...n, sql_content } : n))

    const existing = debounceTimers.current.get(id)
    if (existing) clearTimeout(existing)

    const timer = setTimeout(() => {
      notebooksApi.update(id, { sql_content }).catch(() => {})
      debounceTimers.current.delete(id)
    }, DEBOUNCE_MS)
    debounceTimers.current.set(id, timer)
  }, [])

  const updateDatabase = useCallback(async (id: string, database_id: string | null) => {
    const prev = notebooksRef.current.find(n => n.id === id)?.database_id ?? null
    setNotebooks(p => p.map(n => n.id === id ? { ...n, database_id } : n))
    try {
      await notebooksApi.update(id, { database_id })
    } catch {
      setNotebooks(p => p.map(n => n.id === id ? { ...n, database_id: prev } : n))
    }
  }, [])

  return {
    notebooks,
    activeId,
    setActiveId,
    createNotebook,
    deleteNotebook,
    renameNotebook,
    updateContent,
    updateDatabase,
    loading,
    canCreate: notebooks.length < MAX_NOTEBOOKS,
  }
}
