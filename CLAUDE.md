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

- `worker/wrangler.toml` — CF bindings (DB, KV, extra D1s, domain)
- `worker/migrations/0001_init.sql` — base schema (later changes in `0002_*`, `0003_*`; `routes/setup.ts` mirrors all of them for setup-initialised, prefix-aware databases)
- `worker/src/index.ts` — Hono app entry, SPA fallback
- `worker/src/routes/` — auth, profile, databases, query, admin
- `web/src/pages/Query.tsx` — main SQL editor page
- `web/src/pages/admin/` — admin panel pages

## First-Run Setup

1. Create D1 + KV namespaces in Cloudflare dashboard
2. Fill real IDs into `wrangler.toml` (replace `*_PLACEHOLDER`)
3. Set Worker secrets via dashboard or `wrangler secret put`:
   - `JWT_SECRET` — random 64-char string
   - `ENCRYPTION_KEY` — 64-char hex string (32 bytes) for AES-GCM TOTP / email-secret encryption; anything else is rejected at runtime
   - `SETUP_SECRET` — random string that protects the setup endpoint
4. Set Worker vars:
   - `APP_URL` — your custom domain (e.g. `https://zeta.example.com`); must be the `https://` URL users open (sole CORS origin, passkey RP ID, JWT `iss`/`aud` — changing it signs everybody out)
   - `TABLE_PREFIX` — (optional) prefix for all internal tables, e.g. `kp` → tables become `kp_users`, `kp_settings`, etc. Must be set **before** running setup. Cannot be changed after initialisation.
5. `pnpm run deploy` to build & deploy
6. Initialise the database: `curl -X POST https://<your-domain>/api/setup -H 'Content-Type: application/json' -d '{"secret":"<SETUP_SECRET>"}'` (the old `GET /api/setup/<secret>` form returns 405). Re-run after upgrades — it also applies schema upgrades (e.g. nullable `query_history` refs with `ON DELETE SET NULL`, the `rate_limits` table, rebuilding a `user_database_permissions` table whose foreign keys point at unprefixed tables) to setup-initialised databases; until `rate_limits` exists, rate limits fall back to approximate KV counters
7. Register at `/register` — first user automatically becomes admin. On new installs registration then stays closed (`registration_enabled = false`); open it or create users in the Admin Panel

## Adding a Queryable D1 Database

1. Add a `[[d1_databases]]` entry to `wrangler.toml` with your new binding name (e.g. `QUERY_DB_1`)
2. `pnpm run deploy` to redeploy the Worker with the new binding
3. In the Admin Panel → Databases, register the binding name
4. Grant users access in Admin → Databases → Permissions
