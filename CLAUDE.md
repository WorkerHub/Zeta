# Zeta — Dev Guide

## Commands

```bash
# Worker
cd worker && pnpm dev           # start local dev server (port 8787)
cd worker && pnpm type-check    # check types
cd worker && pnpm migrate:local # apply migrations to local D1
cd worker && pnpm migrate:remote

# Web
cd web && pnpm dev              # Vite dev server (port 5173, proxies /api → 8787)
cd web && pnpm build            # build SPA to web/dist/
cd web && pnpm type-check

# Deploy (from root)
pnpm run deploy   # builds web then deploys worker (which embeds the SPA)

# Formatting (from root)
pnpm format        # format the codebase with biome
pnpm format:check  # verify formatting without writing (also enforced in CI)
```

The repo keeps a `.git-blame-ignore-revs` file listing pure-formatting commits. Opt in locally so `git blame` skips them:

```bash
git config blame.ignoreRevsFile .git-blame-ignore-revs
```

GitHub's blame view reads the file automatically.

## Key Files

- `worker/wrangler.toml` — CF bindings (DB, KV, domain)
- `worker/migrations/0001_init.sql` — base schema (later changes in `0002_*` … `0006_*`; `routes/setup.ts` mirrors all of them for setup-initialised, prefix-aware databases)
- `worker/src/lib/d1-http.ts` — Cloudflare D1 HTTP API client (list account databases, run a query); query targets reach D1 over the REST API instead of bindings
- `worker/src/lib/runs.ts` — saved notebook runs: 512 KB per run, per-notebook run limit and per-user storage quota pruning; fixed per-notebook run numbers (`seq`, taken from `notebooks.last_run_seq`, never reused)
- `worker/src/lib/sql-guard.ts` — SQL classification / permission checks; `limitReadSql` caps reads at 5000 rows in the SQL itself
- `worker/src/index.ts` — Hono app entry, SPA fallback
- `worker/src/routes/` — auth, profile, databases, query, admin
- `web/src/pages/Query.tsx` — main SQL editor page
- `web/src/pages/admin/` — admin panel pages

## First-Run Setup

1. Create D1 + KV namespaces in Cloudflare dashboard
2. Fill real IDs into `wrangler.toml` (replace `*_PLACEHOLDER`)
3. Set the three CI secrets as GitHub repo secrets (the deploy workflow injects them via `wrangler deploy --secrets-file`):
   - `JWT_SECRET` — random 64-char string
   - `SETUP_SECRET` — random string that protects the setup endpoint
   - `CF_D1_API_TOKEN` — a Cloudflare API token with `D1 → Edit` permission (account-scoped); the runtime credential that lists and queries the D1 databases added in the admin panel
   `ENCRYPTION_KEY` stays **Dashboard-only** (not in GitHub Secrets / CI): keep the existing Cloudflare secret as-is — a new value makes stored TOTP credentials and encrypted config undecryptable.
4. Set Worker vars:
   - `APP_URL` — your custom domain (e.g. `https://zeta.example.com`); must be the `https://` URL users open (sole CORS origin, passkey RP ID, JWT `iss`/`aud` — changing it signs everybody out). This is a Dashboard **Worker Variable** — **not a GitHub Secret**.
   - `TABLE_PREFIX` — (optional) prefix for all internal tables. Three states: **unset** → default prefix `zeta`; **set to a value** → that value verbatim, case preserved, with `_` appended (`kp` → `kp_users`, `ZETA` → `ZETA_users`); **set to an empty string** → no prefix. Must be set **before** running setup. Cannot be changed after initialisation. **Upgrade warning:** a deployment that never set `TABLE_PREFIX` used **no prefix** before the three-state change; after upgrading, an unset prefix resolves to `zeta` (different tables). Set it explicitly before upgrading to keep your existing tables (an empty string keeps the old unprefixed tables) or rely on the startup/setup guard, which aborts instead of silently switching — and the guard only matches Zeta's own table family, never other projects' tables in a shared D1 (`SL_*`, `eNotify_*`, `TP_*`, `YL_*`, `TEMP_*`, …).
   - `ALLOW_APP_DB_AS_TARGET` — (optional, default off) set to exactly `true` to allow the app's own database as a query target (shared-database deployments); any other value keeps it excluded. While on, the app DB is guarded: effective permission capped at `write` (destructive statements always rejected, `write_drop` cannot be granted on it) and internal tables (everything `TABLE_PREFIX` resolves to) are read-only, admin included; writes whose target table cannot be determined are rejected. Read-only env var — never written to `wrangler.toml`, GitHub Variables/Secrets or code constants.
   - `CF_ACCOUNT_ID` / `ZETA_APP_DB_ID` are injected automatically at deploy from the GitHub Variables `CLOUDFLARE_ACCOUNT_ID` / `D1_DATABASE_ID` via `wrangler.toml`'s `[vars]` — not set here
5. `pnpm run deploy` to build & deploy
6. Initialise the database: `curl -X POST https://<your-domain>/api/setup -H 'Content-Type: application/json' -d '{"secret":"<SETUP_SECRET>"}'` (the old `GET /api/setup/<secret>` form returns 405). Re-run after upgrades — it also applies schema upgrades (e.g. nullable `query_history` refs with `ON DELETE SET NULL`, the `rate_limits` table, rebuilding a `user_database_permissions` table whose foreign keys point at unprefixed tables, the `notebook_runs` table and `users.notebook_run_limit` column for saved query results, the run numbers `notebook_runs.seq` / `notebooks.last_run_seq` with their backfill and unique index — until setup runs after deploying them, runs are not saved and the run tabs fail to load; and the `d1_databases.cf_database_id` column — until setup runs, the admin add/link database flows fail with `no such column: cf_database_id`) to setup-initialised databases; until `rate_limits` exists, rate limits fall back to approximate KV counters. There is also a `/setup` page for less technical users (the switch to hide it is the `setup_page_enabled` setting, on by default, and only affects the page), and `POST /api/setup` is rate-limited to 3 attempts per 10 minutes per IP. Once initialised, a signed-in admin can run the same check-and-upgrade from **Admin → Settings** (the **Check & upgrade database** button) via `POST /api/admin/setup` — admin-only (`requireAdmin`), no `SETUP_SECRET`; first-time setup still requires the `/setup` page or the `curl` above.
7. Register at `/register` — first user automatically becomes admin. On new installs registration then stays closed (`registration_enabled = false`); open it or create users in the Admin Panel

## Adding a Queryable D1 Database

1. In the Admin Panel → Databases, click **Add database** and pick a D1 database from the account's list (the app's own database is excluded by default; set the `ALLOW_APP_DB_AS_TARGET` Worker variable to add it — its internal tables then stay read-only and destructive operations are disabled on it)
2. Optionally set a display name and description
3. Grant users access in Admin → Databases → Permissions

No binding or redeploy is required: query targets run over the Cloudflare D1 HTTP API using the `CF_D1_API_TOKEN` secret and `CF_ACCOUNT_ID` variable. A database registered by the old binding method has no `cf_database_id` and can't be queried until re-linked — use **Link** on the row in Admin → Databases to switch it to the HTTP API (permissions, history and saved runs are kept).
