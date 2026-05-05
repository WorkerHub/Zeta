import { createContext, useContext, useEffect, useState, useCallback, type ReactNode } from 'react'
import type { User } from '../types'
import { getAccessToken, setSession, clearSession, getCurrentUser } from '../lib/auth'
import { profileApi, authApi } from '../lib/api'

interface AuthContext {
  user: User | null
  loading: boolean
  login: (token: string, user: User) => void
  logout: () => Promise<void>
  refresh: () => Promise<void>
}

const Ctx = createContext<AuthContext | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(getCurrentUser())
  const [loading, setLoading] = useState(!getCurrentUser())

  const login = useCallback((token: string, u: User) => {
    setSession(token, u)
    setUser(u)
  }, [])

  const logout = useCallback(async () => {
    await authApi.logout().catch(() => {})
    clearSession()
    setUser(null)
    window.location.href = '/login'
  }, [])

  const refresh = useCallback(async () => {
    try {
      const data = await fetch('/api/auth/refresh', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
      }).then((r) => (r.ok ? r.json() as Promise<{ accessToken: string }> : null))

      if (!data) { clearSession(); setUser(null); return }

      setSession(data.accessToken, getCurrentUser() ?? { id: '', email: '', name: '', role: 'member' } as User)
      const me = await profileApi.me()
      setSession(data.accessToken, me)
      setUser(me)
    } catch {
      clearSession()
      setUser(null)
    }
  }, [])

  // On mount: try to restore session via refresh cookie
  useEffect(() => {
    if (getCurrentUser()) { setLoading(false); return }
    refresh().finally(() => setLoading(false))
  }, [refresh])

  return <Ctx.Provider value={{ user, loading, login, logout, refresh }}>{children}</Ctx.Provider>
}

export function useAuthContext(): AuthContext {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useAuthContext must be inside AuthProvider')
  return ctx
}
