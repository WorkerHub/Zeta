// ── Auth state (in-memory only, never localStorage) ───────────────────────────

import type { User } from '../types'

let accessToken: string | null = null
let currentUser: User | null = null

export function getAccessToken(): string | null {
  return accessToken
}

export function setSession(token: string, user: User): void {
  accessToken = token
  currentUser = user
}

export function clearSession(): void {
  accessToken = null
  currentUser = null
}

export function getCurrentUser(): User | null {
  return currentUser
}

export function isAuthenticated(): boolean {
  return accessToken !== null
}
