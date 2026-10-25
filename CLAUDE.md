# Zeta — Dev Guide

## Commands

```bash
# Worker
cd worker && pnpm dev           # start local dev server (port 8787)
cd worker && pnpm type-check    # check types

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
- `worker/src/lib/migrations.ts` — the schema, defined once: prefix-parameterised `{ name, sql }` list (`schema_v1` = current schema; append `schema_v2`, … — see **Schema migrations** below)
- `worker/src/lib/migrations-runner.ts` — applies pending migrations and records them in the ledger table `_<prefix>_schema_migrations`, with the anti-silent-switch guard; shared by `POST /api/setup` and `POST /api/admin/setup` (both via `lib/setup.ts`)
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
   - `CLOUDFLARE_API_TOKEN` — the same Cloudflare API token used for `wrangler deploy` authentication, so give it `D1 → Edit` permission (account-scoped); at runtime it is the credential that lists and queries the D1 databases added in the admin panel
   `ENCRYPTION_KEY` stays **Dashboard-only** (not in GitHub Secrets / CI): keep the existing Cloudflare secret as-is — a new value makes stored TOTP credentials and encrypted config undecryptable.
4. Set Worker vars:
   - `APP_URL` — your custom domain (e.g. `https://zeta.example.com`); must be the `https://` URL users open (sole CORS origin, passkey RP ID, JWT `iss`/`aud` — changing it signs everybody out). This is a Dashboard **Worker Variable** — **not a GitHub Secret**.
   - `TABLE_PREFIX` — (optional) prefix for all internal tables. Three states: **unset** → default prefix `zeta`; **set to a value** → that value verbatim, case preserved, with `_` appended (`kp` → `kp_users`, `ZETA` → `ZETA_users`); **set to an empty string** → no prefix. Must be set **before** running setup. Cannot be changed after initialisation. **Upgrade warning:** a deployment that never set `TABLE_PREFIX` used **no prefix** before the three-state change; after upgrading, an unset prefix resolves to `zeta` (different tables). Set it explicitly before upgrading to keep your existing tables (an empty string keeps the old unprefixed tables) or rely on the startup/setup guard, which aborts instead of silently switching — and the guard only matches Zeta's own table family, never other projects' tables in a shared D1 (`SL_*`, `eNotify_*`, `TP_*`, `YL_*`, `TEMP_*`, …).
   - `ALLOW_APP_DB_AS_TARGET` — (optional, default off) managed as a **GitHub repo Variable** and injected into `wrangler.toml`'s `[vars]` at deploy time by `scripts/patch-wrangler.mjs`; changing it needs a redeploy, not a dashboard edit. Set it to exactly `true` to allow the app's own database as a query target (shared-database deployments); any other value keeps it excluded. Missing or blank fails closed: the patch step injects `"false"` instead of failing the deploy (every other placeholder still fails when its variable is missing). While on, the app DB is guarded: effective permission capped at `write` (destructive statements always rejected, `write_drop` cannot be granted on it) and internal tables (everything `TABLE_PREFIX` resolves to, plus the `_<prefix>_schema_migrations` migration ledger) are read-only, admin included; writes whose target table cannot be determined are rejected.
   - `CF_ACCOUNT_ID` / `ZETA_APP_DB_ID` are injected automatically at deploy from the GitHub Variables `CLOUDFLARE_ACCOUNT_ID` / `D1_DATABASE_ID` via `wrangler.toml`'s `[vars]` — not set here
5. `pnpm run deploy` to build & deploy
6. Initialise the database: `curl -X POST https://<your-domain>/api/setup -H 'Content-Type: application/json' -d '{"secret":"<SETUP_SECRET>"}'` (the old `GET /api/setup/<secret>` form returns 405). It applies the pending schema migrations and records them in the ledger table `_<prefix>_schema_migrations`; re-run it after deploying a version that adds a migration, and it only applies what the ledger does not already record. There is also a `/setup` page for less technical users (the switch to hide it is the `setup_page_enabled` setting, on by default, and only affects the page), and `POST /api/setup` is rate-limited to 3 attempts per 10 minutes per IP. Once initialised, a signed-in admin can run the same check-and-upgrade from **Admin → Settings** (the **Check & upgrade database** button) via `POST /api/admin/setup` — admin-only (`requireAdmin`), no `SETUP_SECRET`; first-time setup still requires the `/setup` page or the `curl` above.
7. Register at `/register` — first user automatically becomes admin. On new installs registration then stays closed (`registration_enabled = false`); open it or create users in the Admin Panel

## Schema migrations

The schema lives in exactly one place: `worker/src/lib/migrations.ts`, an ordered list of
`{ name, sql }` entries parameterised by the effective `TABLE_PREFIX`. `lib/setup.ts` hands it to
`lib/migrations-runner.ts`, which creates the ledger table, skips what it already records, applies
the rest in order and records each entry only after its SQL succeeded (first failure stops the run
and leaves that entry unrecorded). Both `POST /api/setup` and `POST /api/admin/setup` go through
that one runner.

- Ledger table: `_` + prefix core + `_schema_migrations` — `_ZETA_schema_migrations` for
  `TABLE_PREFIX=ZETA`, `_zeta_schema_migrations` for the default prefix, `_schema_migrations` for
  none. Always through `migrationsTable()` in `worker/src/lib/db.ts`; never build the name by hand.
- History was collapsed: Zeta has no production data, so the old `worker/migrations/0001–0006`
  files and the PRAGMA probing upgrades are gone, replaced by `schema_v1` = the current schema. The
  wrangler `d1 migrations apply` path (`pnpm migrate:*`) is gone too — the setup ledger is the only
  schema path.
- Adding a migration: append at the end (`schema_v2`, `schema_v3`, …); never edit, reorder or rename
  a merged entry (databases that recorded it will not run it again). Keep migrations additive
  (`CREATE TABLE/INDEX IF NOT EXISTS`, `ALTER TABLE … ADD COLUMN`, `INSERT OR IGNORE`) — no drops,
  renames or data rewrites; destructive changes need their own spec.
- Keep migration SQL free of `--` line comments: `exec()` collapses it onto one line (see the runner).
- The guard refuses to migrate when the D1 database already holds a Zeta schema under another prefix,
  and when the resolved prefix's ledger recorded migrations while its tables are missing (drop the
  ledger as well to re-initialise).
- Old, pre-ledger deployments are not upgraded in place: delete their own prefixed tables and the
  ledger table, then run setup again (or stay on the old version). Documented as breaking for
  external self-hosted copies.

## Adding a Queryable D1 Database

1. In the Admin Panel → Databases, click **Add database** and pick a D1 database from the account's list (the app's own database is excluded by default; set the `ALLOW_APP_DB_AS_TARGET` GitHub repo Variable and redeploy to add it — its internal tables then stay read-only and destructive operations are disabled on it)
2. Optionally set a display name and description
3. Grant users access in Admin → Databases → Permissions

No binding or redeploy is required: query targets run over the Cloudflare D1 HTTP API using the `CLOUDFLARE_API_TOKEN` secret and `CF_ACCOUNT_ID` variable. A database registered by the old binding method has no `cf_database_id` and can't be queried until re-linked — use **Link** on the row in Admin → Databases to switch it to the HTTP API (permissions, history and saved runs are kept).
