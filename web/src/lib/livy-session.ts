import type { LivySessionKind } from '../types'

export const LIVY_SESSIONS_KEY = 'zeta:livy-sessions'

export interface CachedLivySession {
  sessionId: number
  kind: LivySessionKind
}

export type LivySessionMap = Record<string, CachedLivySession>

const VALID_KINDS = new Set<LivySessionKind>(['spark', 'pyspark', 'sql'])

export function isLivySessionKind(value: unknown): value is LivySessionKind {
  return typeof value === 'string' && VALID_KINDS.has(value as LivySessionKind)
}

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

export function sessionKey(userId: string, databaseId: string): string {
  return `${userId}:${databaseId}`
}

export function parseSessionMap(raw: string | null): LivySessionMap {
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    const result: LivySessionMap = {}
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (
        k !== '' &&
        typeof v === 'object' &&
        v !== null &&
        'sessionId' in v &&
        typeof (v as { sessionId: unknown }).sessionId === 'number' &&
        'kind' in v &&
        isLivySessionKind((v as { kind: unknown }).kind)
      ) {
        result[k] = {
          sessionId: (v as { sessionId: number }).sessionId,
          kind: (v as { kind: LivySessionKind }).kind,
        }
      }
    }
    return result
  } catch {
    return {}
  }
}

export function readSessionMap(): LivySessionMap {
  return parseSessionMap(storage()?.getItem(LIVY_SESSIONS_KEY) ?? null)
}

export function writeSessionMap(map: LivySessionMap): void {
  try {
    storage()?.setItem(LIVY_SESSIONS_KEY, JSON.stringify(map))
  } catch {
    // Ignore storage write failure
  }
}

export function readLivySession(userId: string, databaseId: string): CachedLivySession | null {
  if (!userId || !databaseId) return null
  const map = readSessionMap()
  return map[sessionKey(userId, databaseId)] ?? null
}

export function rememberLivySession(userId: string, databaseId: string, session: CachedLivySession): void {
  if (!userId || !databaseId) return
  const map = readSessionMap()
  map[sessionKey(userId, databaseId)] = session
  writeSessionMap(map)
}

export function forgetLivySession(userId: string, databaseId: string): void {
  if (!userId || !databaseId) return
  const map = readSessionMap()
  const key = sessionKey(userId, databaseId)
  if (key in map) {
    delete map[key]
    writeSessionMap(map)
  }
}
