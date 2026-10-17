# Zeta

> [**中文文档**](./README_zh-CN.md) | [**English**](./README.md)

A self-hosted SQL query interface for [Cloudflare D1](https://developers.cloudflare.com/d1/) databases. Runs entirely on Cloudflare — no servers to manage.

**Version 1.0.0**

![Stack](https://img.shields.io/badge/Cloudflare-Workers-orange?logo=cloudflare) ![Stack](https://img.shields.io/badge/Hono-v4-blue) ![Stack](https://img.shields.io/badge/React-19-61dafb?logo=react) ![Stack](https://img.shields.io/badge/TypeScript-5-blue?logo=typescript)

---

## Features

- **SQL Notebooks** — Multiple named SQL editor tabs per user, auto-saved, each independently bound to a database; supports rename, reorder, and up to 20 notebooks per user
- **SQL Editor** — Full SQL input with syntax highlighting (CodeMirror 6), Ctrl/Cmd+Enter to run, partial selection execution, execution time and row count display; read queries return at most 5,000 rows, capped in the SQL itself
- **Saved Results** — Every notebook run is saved with its results, so they survive switching tabs, leaving the page, reloading and changing devices; a notebook's runs sit in a row of numbered tabs (… #3 #2 #1, newest on the left) to switch between, delete or clear, and the **History** button in the top bar opens a resizable drawer with every run of the notebook (see [Saved Query Results](#saved-query-results))
- **Multi-database** — Connect multiple D1 databases; grant per-user `read` or `write` access per database
- **Auth** — Email + password login, email verification, password reset, optional TOTP / Email OTP / Passkey (WebAuthn) two-factor authentication
- **Admin Panel** — Manage users, database connections, permissions, and email/app settings
- **i18n** — Built-in English and Chinese (Simplified) interface
- **Dark / Light / Auto theme** — Follows system preference by default
- **100% Cloudflare** — Workers + D1 + KV + Workers Assets; the only external dependency is an email provider (Resend or SMTP)

---

## Architecture

```
┌─────────────────────────────────┐
│  Cloudflare Worker (Hono.js)    │
│  ┌────────────┐  ┌────────────┐ │
│  │  /api/*    │  │  SPA       │ │
│  │  REST API  │  │  (Assets)  │ │
│  └─────┬──────┘  └────────────┘ │
│        │                        │
│  ┌─────▼──────┐  ┌────────────┐ │
│  │  D1 (app)  │  │  KV        │ │
│  │  + D1 DBs  │  │  (sessions)│ │
│  └────────────┘  └────────────┘ │
└─────────────────────────────────┘
```

| Layer | Technology |
|-------|-----------|
| Runtime | Cloudflare Workers |
| API framework | Hono.js v4 |
| App database | D1 (SQLite) — users, notebooks, settings, history |
| Query targets | Additional D1 bindings |
| Sessions / 2FA state | Cloudflare KV |
| Frontend | React 19 + Vite + Tailwind CSS v4 |

---

## Deployment via GitHub Actions

Deployment runs automatically on every push to `main`. No local tooling required beyond a browser.

### Step 1 — Create Cloudflare resources

Go to the [Cloudflare dashboard](https://dash.cloudflare.com) and create:

**D1 database** (Workers & Pages → D1 → Create database)
- Name: `zeta-db` (or any name you like)
- Note the **Database ID** shown after creation

**KV namespace** (Workers & Pages → KV → Create namespace)
- Name: `ZETA_KV`
- Note the **Namespace ID**

**API token** (My Profile → API Tokens → Create Token)
- Use the **Edit Cloudflare Workers** template
- Note the token value — it is shown only once

Also note your **Account ID** (right sidebar on the dashboard home).

---

### Step 2 — Configure GitHub repository

In your GitHub repo → **Settings → Secrets and variables → Actions**:

**Secrets** (encrypted, for sensitive values):

| Name | Value |
|------|-------|
| `CLOUDFLARE_API_TOKEN` | The API token from Step 1 |

**Variables** (plain-text, for non-sensitive IDs):

| Name | Value |
|------|-------|
| `CLOUDFLARE_ACCOUNT_ID` | Your Cloudflare Account ID |
| `D1_DATABASE_NAME` | e.g. `zeta-db` |
| `D1_DATABASE_ID` | The D1 Database ID from Step 1 |
| `KV_NAMESPACE_ID` | The KV Namespace ID from Step 1 |

---

### Step 3 — Configure Cloudflare Worker secrets & variables

These values are sensitive or deployment-specific and are set **directly in the Cloudflare dashboard**, not in GitHub.

Go to **Workers & Pages → zeta → Settings → Variables and Secrets**:

**Secrets** (type: Secret):

| Name | How to generate |
|------|----------------|
| `JWT_SECRET` | Any random 64-char string — e.g. `openssl rand -hex 32` |
| `ENCRYPTION_KEY` | 64-char hex (32 bytes) — e.g. `openssl rand -hex 32`. Validated strictly: any other value (a passphrase, a shorter key) is rejected instead of silently yielding a weak key |
| `SETUP_SECRET` | Any random string — e.g. `openssl rand -hex 16` |

**Variables** (type: Text):

| Name | Value |
|------|-------|
| `APP_URL` | Your Worker URL, e.g. `https://zeta.yourname.workers.dev` or your custom domain. Use the exact `https://` URL users open: it is the only origin CORS allows, the passkey RP ID, the base of email links and the issuer/audience of every login token (changing it later signs everybody out) |
| `TABLE_PREFIX` | *(Optional)* Prefix for all internal D1 tables, e.g. `kp` → tables become `kp_users`, `kp_settings`, etc. Must be set **before** calling the setup endpoint. Cannot be changed after initialisation. |

> These are kept out of GitHub entirely. The `keep_vars = true` setting in `wrangler.toml` ensures each deployment never overwrites values you set here.

---

### Step 4 — Push to deploy

```bash
git push origin main
```

The [GitHub Actions workflow](.github/workflows/deploy.yml) will:
1. Install dependencies
2. Build the React SPA
3. Patch `wrangler.toml` with the IDs from GitHub Variables
4. Run `wrangler deploy`

Watch progress under the **Actions** tab in your repository.

---

### Step 5 — Initialise the database

After the first successful deployment, send this request **once** (the secret travels in the request body, so it never ends up in browser history, access logs or `Referer` headers):

```bash
curl -X POST https://<your-domain>/api/setup \
  -H 'Content-Type: application/json' \
  -d '{"secret":"<SETUP_SECRET>"}'
```

Expected response:

```json
{ "ok": true, "message": "Database initialised successfully. You can now register at /register — the first user becomes admin. On new installs registration then stays closed until an admin opens it in Admin → Settings." }
```

> The endpoint is idempotent — safe to call multiple times. **Re-run it after every upgrade**: it also applies schema upgrades to databases created by earlier versions (e.g. making `query_history` keep rows when a user or database is deleted — until then, deleting users or databases fails — and creating the `rate_limits` table that makes login / 2FA / email rate limits exact; until it exists they fall back to approximate KV counters; and rebuilding a `user_database_permissions` table whose foreign keys still point at unprefixed `users` / `d1_databases` tables — until then, granting or revoking database access and deleting users or databases fail with `no such table`. Permission rows whose user or database no longer exists are dropped; the response reports how many under `permissionsRepair`; and creating the `notebook_runs` table plus the `users.notebook_run_limit` column for [saved query results](#saved-query-results) — until then, runs are not saved and the list of saved runs fails to load; and numbering saved runs: adding `notebook_runs.seq` and `notebooks.last_run_seq`, numbering the existing runs of each notebook from 1 (oldest first) and adding a unique `(notebook_id, seq)` index — **after deploying the version with numbered run tabs, call it once more**: until then, queries still run but are not saved, and the run tabs fail to load). Databases created from the migrations get the same through `pnpm migrate:remote` (`0004_notebook_runs.sql`, `0005_notebook_run_seq.sql`).
>
> Earlier versions used `GET /api/setup/<SETUP_SECRET>`. That form is gone: it now returns `405` and does nothing. If you ever opened the old URL, consider rotating `SETUP_SECRET`.

---

### Step 6 — Create the admin account

Visit `https://<your-domain>/register`. The **first registered user automatically becomes admin**.

On new installs, registration closes as soon as that first account exists. Afterwards:
- Create accounts in **Admin → Users**, or open self-registration in **Admin → Settings** (consider also requiring email verification and 2FA there once an email provider is configured)
- Add queryable D1 databases in **Admin → Databases**
- Grant users access in **Admin → Databases → Permissions**

---

## Adding a Queryable D1 Database

D1 databases are injected into the Worker at deploy time via GitHub Actions Variables — no file editing required.

1. In your GitHub repo → **Settings → Secrets and variables → Actions → Variables**, add two variables:

   | Name | Value |
   |------|-------|
   | `QUERY_DB_N_NAME` | The D1 database name (e.g. `my-app-db`) |
   | `QUERY_DB_N_ID` | The D1 database ID (UUID from the Cloudflare dashboard) |

   Replace `N` with a number from 1 to 10 (e.g. `QUERY_DB_1_NAME`, `QUERY_DB_1_ID`). Numbers don't need to be consecutive.

2. Push to `main` (or trigger **workflow_dispatch**) — the Actions workflow will automatically append a `[[d1_databases]]` binding for every `QUERY_DB_N` pair that is set.

3. In **Admin → Databases**, click **Add database** and enter the binding name (e.g. `QUERY_DB_1`).

4. In **Databases → Permissions**, grant users `read` or `write` access.

---

## Saved Query Results

Every run of a notebook (one statement or several) is stored in the app database (`notebook_runs`) together with its results. Above the results, a notebook's runs are shown as tabs numbered from right to left — `… #5 #4 #3 #2 #1`, the newest on the left and selected when the notebook opens. The strip scrolls sideways (trackpad, touch, mouse wheel) and loads older runs on reaching its right end; hovering a tab shows when the run ran, its database, row count and SQL. A tab's × deletes that run right away (Delete / Backspace on a focused tab does the same, ←/→ switch tabs). **History** in the top bar opens a drawer with every run of the notebook: pick one to read its SQL and results, delete a single run, or clear them all after a confirmation; older runs load as the list is scrolled. The drawer opens at half the window width, and dragging its left edge (or moving it with the arrow keys) resizes it. A run's number never changes and is never reused: deleting or pruning runs leaves gaps (the oldest run left may be #37), and each notebook counts on its own.

Two limits keep it bounded, both set in **Admin → Settings → Saved query runs**:

| Limit | Default | Range | Effect |
|-------|---------|-------|--------|
| Runs kept per notebook | 100 | 1–1000 | Older runs of the notebook are deleted. Users can keep fewer under **Profile → Saved query runs**; the lower of the two applies. |
| Saved results per user | 50 MB | 1–1024 MB | Beyond it, the user's oldest runs (in any notebook) are deleted. |

Lowering either limit applies to the runs already stored right away. A single run stores at most 512 KB of results (D1 rows are capped at 2 MB); larger results keep their first rows, and the result panel says so. Separately, read queries return at most 5,000 rows: `SELECT`, `VALUES` and `WITH` statements run as `SELECT * FROM (<statement>) LIMIT 5001`, so the database itself stops early (`PRAGMA` / `EXPLAIN` are cut off afterwards).

**Sizing:** the app database holds up to *users × saved results per user* of runs — 10 users at the default 50 MB is about 500 MB, the size limit of a D1 database on the Workers Free plan (10 GB on Workers Paid). Adjust the limits to the number of users.

**Security:** saved results are stored unencrypted in the app database, like the queried data itself in its own database. Only their owner can list or read them, and reading re-checks access to the queried database every time: results stay hidden while a database is deactivated, and are deleted when the user's access to the database is revoked, or when the database, notebook or user is deleted.

---

## Local Development

Run the Worker and web dev server concurrently in two terminals:

```bash
# Terminal 1 – Worker (port 8787)
cd worker && pnpm dev

# Terminal 2 – Vite (port 5173, proxies /api → 8787)
cd web && pnpm dev
```

Create `worker/.dev.vars` for local secrets:

```ini
JWT_SECRET=dev-jwt-secret
ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000001
SETUP_SECRET=dev-setup-secret
APP_URL=http://localhost:8787
```

Initialise the local database:

```bash
curl -X POST http://localhost:8787/api/setup \
  -H 'Content-Type: application/json' \
  -d '{"secret":"dev-setup-secret"}'
```

Then open `http://localhost:5173` in your browser.

### Formatting

From the repo root:

```bash
pnpm format        # format the codebase with biome
pnpm format:check  # verify formatting without writing (also enforced in CI)
```

Pure-formatting commits are listed in `.git-blame-ignore-revs`, which GitHub's blame view reads automatically. To get the same behaviour locally, run once per clone:

```bash
git config blame.ignoreRevsFile .git-blame-ignore-revs
```

---

## Configuration Reference

### GitHub Secrets & Variables

| Name | Where | Description |
|------|-------|-------------|
| `CLOUDFLARE_API_TOKEN` | Secret | Wrangler deploy authentication |
| `CLOUDFLARE_ACCOUNT_ID` | Variable | Cloudflare account ID |
| `D1_DATABASE_NAME` | Variable | D1 database name (e.g. `zeta-db`) |
| `D1_DATABASE_ID` | Variable | D1 database ID |
| `KV_NAMESPACE_ID` | Variable | KV namespace ID |
| `QUERY_DB_N_NAME` | Variable | Query database name for slot N (1–10), e.g. `QUERY_DB_1_NAME` |
| `QUERY_DB_N_ID` | Variable | Query database ID for slot N (1–10), e.g. `QUERY_DB_1_ID` |

### Cloudflare Dashboard (set manually)

| Name | Type | Description |
|------|------|-------------|
| `JWT_SECRET` | Secret | Signs access + refresh JWTs (HS256) |
| `ENCRYPTION_KEY` | Secret | 64-char hex (strictly validated) — AES-GCM key for TOTP secrets and SMTP/Resend credentials |
| `SETUP_SECRET` | Secret | Protects `POST /api/setup` |
| `APP_URL` | Variable | Full URL of your deployment; also the JWT `iss`/`aud`, so tokens from another deployment sharing `JWT_SECRET` are rejected |
| `TABLE_PREFIX` | Variable | *(Optional)* Prefix for internal tables (e.g. `kp`). Set before first setup run. Immutable after initialisation. |

---

## API Overview

All endpoints live under `/api/`. Authentication uses short-lived JWT access tokens (Authorization header) plus an HttpOnly refresh-token cookie. Request bodies are capped at 4 MB (larger ones get `413`).

| Prefix | Description |
|--------|-------------|
| `POST /api/auth/*` | Register, login, logout, token refresh, email verification, password reset, 2FA (TOTP / Email OTP / Passkey) |
| `GET/PATCH /api/profile/*` | Profile, password change, TOTP setup/confirm/delete, passkey registration/delete. Deleting a TOTP or passkey requires a JSON body `{"currentPassword": "..."}` |
| `GET /api/databases` | List accessible databases for the current user |
| `POST /api/query` | Execute SQL against a bound D1 database (`/batch` for several statements). Reads return at most 5,000 rows (`truncated: true` beyond). With `notebookId`, the run is saved under that notebook and the response carries `run_id` / `seq` (its number) / `executed_at` |
| `GET /api/query/history` | Query execution history (filterable by database) |
| `GET/POST/PATCH/DELETE /api/notebooks` | CRUD for SQL notebooks (per-user, max 20) |
| `GET/DELETE /api/notebooks/:id/runs[/:runId]` | A notebook's saved runs: list (highest number `seq` first, `limit` plus `before=<seq>` or `offset`), read one with its results, delete one, or clear all |
| `GET/PUT /api/profile/run-settings` | The user's own run limit (`run_limit`, `null` follows the admin limit) and storage usage |
| `GET/POST/PATCH/DELETE /api/admin/*` | Admin-only: users, databases, permissions, settings |
| `POST /api/setup` | Idempotent schema initialisation (JSON body `{"secret": "<SETUP_SECRET>"}`) |
| `GET /api/health` | Health check |

---

## Tech Stack

| | |
|---|---|
| **Runtime** | Cloudflare Workers |
| **API** | [Hono](https://hono.dev) v4 |
| **Database** | [Cloudflare D1](https://developers.cloudflare.com/d1/) (SQLite) |
| **KV** | [Cloudflare KV](https://developers.cloudflare.com/kv/) |
| **Frontend** | React 19, Vite, Tailwind CSS v4 |
| **SQL Editor** | CodeMirror 6 + `@codemirror/lang-sql` |
| **Auth** | PBKDF2-SHA256 passwords, HS256 JWTs, WebAuthn passkeys |
| **2FA** | TOTP (otpauth), Email OTP, Passkey |
| **Email** | [Resend](https://resend.com) or custom SMTP |
| **Deploy** | `wrangler deploy` via GitHub Actions |

---

## License

[MIT](LICENSE)
