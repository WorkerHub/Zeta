import type { Env } from '../types'
import { now, tables } from './db'

// ── Brand-colour preset (per account) ────────────────────────────────────────────────────────
// The preset is a display choice: the server stores the id and hands it back, and the browser owns
// what each id paints (web/src/lib/theme-color.ts, which also lists the ids for the picker and
// public/theme-init.js, over the tokens in index.css — see docs/design-system.md §2.1).
// This list is the API's authority: it mirrors that one and the ids frozen in the endpoint contract.
// A new preset is a cross-cutting change (CSS tokens, theme-init.js, the web list and this list) —
// never add it on one side only.

export const THEME_COLORS = ['terracotta', 'ocean', 'teal', 'forest', 'grape', 'rose'] as const

export type ThemeColor = (typeof THEME_COLORS)[number]

export function isThemeColor(value: unknown): value is ThemeColor {
  return typeof value === 'string' && (THEME_COLORS as readonly string[]).includes(value)
}

/** Shown to the user when the preset was picked but the column does not exist yet. */
export const THEME_COLOR_UPGRADE_REQUIRED =
  'Theme colour is unavailable until the database upgrade runs. An admin can run it in Admin → Settings (Check & upgrade database).'

// The column arrives with schema_v6, and only the setup/admin upgrade applies migrations — a deploy
// does not. Until it runs, the users table has no theme_color and SQLite names the missing column in
// one of two ways, both reproduced against a real database:
//
//   SELECT theme_color …, UPDATE … SET theme_color = …   →  no such column: theme_color
//   INSERT INTO users (theme_color) VALUES (…)            →  table users has no column named theme_color
//
// The paths here only ever issue the first form, so that is the one that must match; the second is
// kept for the INSERT-shaped statements the same column would appear in. D1 prefixes its own code
// (`D1_ERROR: <sqlite message>: SQLITE_ERROR`), which is why these are substrings of the message
// and not the whole of it. Every other database error keeps its own path, so a broken connection is
// never reported as "needs an upgrade".
const MISSING_COLUMN = [/no such column: theme_color\b/i, /has no column named theme_color\b/i]

export function isMissingThemeColorColumn(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err)
  return MISSING_COLUMN.some((pattern) => pattern.test(message))
}

export class ThemeColorColumnMissingError extends Error {
  constructor() {
    super(THEME_COLOR_UPGRADE_REQUIRED)
    this.name = 'ThemeColorColumnMissingError'
  }
}

/**
 * The account's preset, or null when it has none — which is also what a database that predates
 * schema_v6 reports, so a caller shows the default either way. A stored value that is not a known
 * preset (a hand-edited row, or a preset that was removed) reads as "no preset" instead of leaking
 * an id the browser cannot paint.
 */
export async function readThemeColor(
  env: Pick<Env, 'DB' | 'TABLE_PREFIX'>,
  userId: string
): Promise<ThemeColor | null> {
  const T = tables(env)
  try {
    const row = await env.DB.prepare(`SELECT theme_color FROM ${T.users} WHERE id = ?1`)
      .bind(userId)
      .first<{ theme_color: string | null }>()
    return isThemeColor(row?.theme_color) ? row.theme_color : null
  } catch (err) {
    if (isMissingThemeColorColumn(err)) return null
    throw err
  }
}

/** Stores the account's preset and moves `updated_at`, like every other profile write. */
export async function writeThemeColor(
  env: Pick<Env, 'DB' | 'TABLE_PREFIX'>,
  userId: string,
  color: ThemeColor
): Promise<void> {
  const T = tables(env)
  try {
    await env.DB.prepare(`UPDATE ${T.users} SET theme_color = ?1, updated_at = ?2 WHERE id = ?3`)
      .bind(color, now(), userId)
      .run()
  } catch (err) {
    if (isMissingThemeColorColumn(err)) throw new ThemeColorColumnMissingError()
    throw err
  }
}
