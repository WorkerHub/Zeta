import { useCallback, useEffect, useState } from 'react'
import { sparkProfilesApi } from '../lib/api'
import {
  readSelectedProfiles,
  rememberSelectedProfile,
  selectedProfileOf,
  writeSelectedProfiles,
  type SparkProfileMap,
} from '../lib/spark-profile'
import type { SparkProfile } from '../types'

/**
 * The caller's personal Spark config profiles for one target, plus the per-target selected profile
 * (§5.3). The list is fetched; the selection lives in sessionStorage (lib/spark-profile.ts) so a
 * fresh device starts on the default configuration. Pass a non-Spark target as `null` — the hook
 * then holds no list and no selection.
 */
export function useSparkProfiles(databaseId: string | null) {
  const [profiles, setProfiles] = useState<SparkProfile[]>([])
  const [selected, setSelected] = useState<SparkProfileMap>(() => readSelectedProfiles())
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    writeSelectedProfiles(selected)
  }, [selected])

  useEffect(() => {
    if (!databaseId) {
      setProfiles([])
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    sparkProfilesApi
      .list(databaseId)
      .then((res) => {
        if (cancelled) return
        setProfiles(res.results)
        // A selection that no longer exists (deleted elsewhere) falls back to the default.
        setSelected((current) => {
          const sid = selectedProfileOf(current, databaseId)
          if (sid !== null && !res.results.some((p) => p.id === sid)) {
            return rememberSelectedProfile(current, databaseId, null)
          }
          return current
        })
      })
      .catch(() => {
        if (!cancelled) setProfiles([])
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [databaseId])

  const selectedProfileId = databaseId ? selectedProfileOf(selected, databaseId) : null

  const select = useCallback(
    (profileId: string | null) => {
      if (!databaseId) return
      setSelected((current) => rememberSelectedProfile(current, databaseId, profileId))
    },
    [databaseId]
  )

  const reload = useCallback(() => {
    if (!databaseId) return
    sparkProfilesApi
      .list(databaseId)
      .then((res) => setProfiles(res.results))
      .catch(() => {})
  }, [databaseId])

  return { profiles, selectedProfileId, select, reload, loading }
}
