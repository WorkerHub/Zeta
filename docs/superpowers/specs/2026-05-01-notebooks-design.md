# Notebook Feature Design

**Date:** 2026-05-01  
**Status:** Approved

## Overview

Add per-user notebook support to D1 Studio. Each notebook is an independent SQL editor with its own name, SQL content, and associated database. Users can manage multiple notebooks and switch between them via a tab bar, similar to browser tabs.

## Requirements

- **Storage:** Server-side (D1 database), notebooks persist across devices
- **Save timing:** Auto-save with 1.5s debounce after user stops typing
- **Database binding:** Each notebook independently binds to one database
- **Naming:** User-defined names (default "Untitled"), double-click to rename inline
- **Tab limit:** Maximum 20 notebooks per user
- **Tab overflow:** Horizontal scroll when tabs overflow

## Database Schema

New migration file: `worker/migrations/0002_notebooks.sql`

```sql
CREATE TABLE notebooks (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL DEFAULT 'Untitled',
  sql_content TEXT NOT NULL DEFAULT '',
  database_id TEXT REFERENCES d1_databases(id) ON DELETE SET NULL,
  position INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_notebooks_user ON notebooks(user_id);
```

- `position` tracks tab display order (0-based integer)
- `database_id` nullable — notebook can exist without a database selected
- `sql_content` stores full SQL text

The `tables()` helper in `worker/src/lib/db.ts` must be extended to include `notebooks`.

## API Routes

New file: `worker/src/routes/notebooks.ts`, mounted at `/api/notebooks` in `worker/src/index.ts`.

All routes require auth (`requireAuth` middleware). Users can only access their own notebooks.

| Method | Path | Body / Params | Description |
|--------|------|---------------|-------------|
| `GET` | `/api/notebooks` | — | List all notebooks for current user, ordered by `position ASC` |
| `POST` | `/api/notebooks` | `{ name?, database_id? }` | Create notebook. Auto-assigns `position = max(existing) + 1`. Rejects if user already has 20 notebooks. |
| `PATCH` | `/api/notebooks/:id` | `{ name?, sql_content?, database_id?, position? }` | Partial update. All fields optional. |
| `DELETE` | `/api/notebooks/:id` | — | Delete notebook. Reorders remaining notebooks' positions sequentially. |

### Response shapes

**GET /api/notebooks:**
```json
{ "results": [{ "id": "...", "name": "...", "sql_content": "...", "database_id": "...", "position": 0, "created_at": 0, "updated_at": 0 }] }
```

**POST /api/notebooks:**
```json
{ "id": "...", "name": "Untitled", "sql_content": "", "database_id": null, "position": 0, "created_at": 0, "updated_at": 0 }
```

## Frontend Architecture

### New hook: `web/src/hooks/useNotebooks.ts`

Manages all notebook state. Interface:

```ts
interface Notebook {
  id: string
  name: string
  sql_content: string
  database_id: string | null
  position: number
}

interface UseNotebooksReturn {
  notebooks: Notebook[]
  activeId: string | null
  setActiveId: (id: string) => void
  createNotebook: () => Promise<void>
  deleteNotebook: (id: string) => Promise<void>
  renameNotebook: (id: string, name: string) => Promise<void>
  updateContent: (id: string, sql: string) => void        // triggers debounced save
  updateDatabase: (id: string, databaseId: string | null) => Promise<void>
  loading: boolean
  canCreate: boolean   // false when at 20-notebook limit
}
```

**Behavior:**
- On mount: fetch all notebooks from API. If none exist, auto-create one default notebook.
- `activeId` is persisted to `localStorage` under key `d1studio_active_notebook`. On mount, restore from localStorage if the notebook still exists.
- `updateContent` applies an optimistic local update immediately, then sends a PATCH after 1.5s debounce. The debounce timer resets on each call.
- `deleteNotebook`: if deleting the active notebook, activate the adjacent tab (prefer the one to the left, or the first remaining one).

### Modified: `web/src/pages/Query.tsx`

**Tab Bar** — inserted as a new row between the header and the editor area:

```
[header: logo | db-selector | ... | user-menu]
[tab bar: [tab1 ×] [tab2 ×] [active-tab3 ×] [+]     ]
[sql editor (draggable)]
[divider]
[results]
```

Tab bar details:
- Horizontal scrollable row (`overflow-x: auto`, `scrollbar-none` on mobile)
- Each tab: name text + `×` close button
- Active tab: blue underline border + slightly different bg
- Double-click on tab name → inline `<input>` for renaming, blur/Enter confirms
- `+` button at the end; disabled and grayed out when `canCreate === false`
- All tab interactions go through `useNotebooks` hook

**State changes in Query.tsx:**
- Remove `sqlText` / `setSqlText` state — SQL content now lives in `useNotebooks`
- Remove the single `selectedDb` state — active notebook's `database_id` is the source of truth
- When CodeMirror onChange fires → call `updateContent(activeId, value)`
- When database selector changes → call `updateDatabase(activeId, db.id)`

### New API client: `web/src/lib/api.ts`

Add `notebooksApi`:

```ts
export const notebooksApi = {
  list: () => apiFetch<{ results: Notebook[] }>('/notebooks'),
  create: (body?: { name?: string; database_id?: string }) =>
    apiFetch<Notebook>('/notebooks', { method: 'POST', body: JSON.stringify(body ?? {}) }),
  update: (id: string, body: Partial<Pick<Notebook, 'name' | 'sql_content' | 'database_id' | 'position'>>) =>
    apiFetch<{ message: string }>(`/notebooks/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  delete: (id: string) =>
    apiFetch<{ message: string }>(`/notebooks/${id}`, { method: 'DELETE' }),
}
```

### i18n keys to add

```ts
'notebook.untitled': 'Untitled' / '未命名'
'notebook.new': 'New notebook' / '新建 Notebook'
'notebook.delete_confirm': 'Delete this notebook?' / '删除此 Notebook？'
'notebook.limit_reached': 'Maximum 20 notebooks reached' / '已达到 20 个上限'
```

## Error Handling

- If auto-save fails (network error), show a subtle error indicator on the tab (red dot). Retry on next edit.
- If notebook limit is reached, disable the `+` button and show a tooltip.
- If `database_id` in a notebook points to a database the user no longer has access to, treat it as `null` (show "Select database" in the selector).

## Out of Scope

- Notebook sharing between users
- Notebook folders / tags
- Export/import notebooks
- Drag-to-reorder tabs (manual reorder — position is written but reorder UI is not implemented)
