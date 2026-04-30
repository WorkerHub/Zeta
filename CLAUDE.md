# D1 Studio — Dev Guide

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
pnpm deploy   # builds web then deploys worker (which embeds the SPA)
```

## Key Files

- `worker/wrangler.toml` — CF bindings (DB, KV, extra D1s, domain)
- `worker/migrations/0001_init.sql` — full schema
- `worker/src/index.ts` — Hono app entry, SPA fallback
- `worker/src/routes/` — auth, profile, databases, query, admin
- `web/src/pages/Query.tsx` — main SQL editor page
- `web/src/pages/admin/` — admin panel pages

## First-Run Setup

1. Create D1 + KV namespaces in Cloudflare dashboard
2. Fill real IDs into `wrangler.toml` (replace `*_PLACEHOLDER`)
3. Set Worker secrets via dashboard or `wrangler secret put`:
   - `JWT_SECRET` — random 64-char string
   - `ENCRYPTION_KEY` — 64-char hex string (32 bytes) for AES-GCM TOTP encryption
   - `SETUP_SECRET` — random string that protects the setup endpoint
4. Set Worker vars:
   - `APP_URL` — your custom domain (e.g. `https://d1studio.example.com`)
5. `pnpm deploy` to build & deploy
6. Visit `https://<your-domain>/api/setup/<SETUP_SECRET>` to initialise the database
7. Register at `/register` — first user automatically becomes admin

## Adding a Queryable D1 Database

1. Add a `[[d1_databases]]` entry to `wrangler.toml` with your new binding name (e.g. `QUERY_DB_1`)
2. `pnpm deploy` to redeploy the Worker with the new binding
3. In the Admin Panel → Databases, register the binding name
4. Grant users access in Admin → Databases → Permissions
