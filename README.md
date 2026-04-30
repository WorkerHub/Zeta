# D1 Studio

A self-hosted SQL query interface for [Cloudflare D1](https://developers.cloudflare.com/d1/) databases. Runs entirely on Cloudflare — no servers to manage.

![Stack](https://img.shields.io/badge/Cloudflare-Workers-orange?logo=cloudflare) ![Stack](https://img.shields.io/badge/Hono-v4-blue) ![Stack](https://img.shields.io/badge/React-19-61dafb?logo=react) ![Stack](https://img.shields.io/badge/TypeScript-5-blue?logo=typescript)

---

## Features

- **SQL Editor** — Full SQL input with syntax highlighting (CodeMirror 6), Ctrl/Cmd+Enter to run, execution time and row count
- **Query History** — Last 50 queries per database, click to re-run
- **Multi-database** — Connect multiple D1 databases; grant per-user `read` or `write` access per database
- **Auth** — Email + password, email verification, password reset, optional TOTP / Email OTP / Passkey (WebAuthn) 2FA
- **Admin Panel** — Manage users, database connections, permissions, and email/app settings
- **100% Cloudflare** — Workers + D1 + KV + Workers Assets; only external dependency is an email provider (Resend or SMTP)

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
| App database | D1 (SQLite) — users, settings, history |
| Query targets | Additional D1 bindings |
| Sessions / 2FA | Cloudflare KV |
| Frontend | React 19 + Vite + Tailwind CSS |

---

## Deployment via GitHub Actions

Deployment runs automatically on every push to `main`. No local tooling required beyond a browser.

### Step 1 — Create Cloudflare resources

Go to the [Cloudflare dashboard](https://dash.cloudflare.com) and create:

**D1 database** (Workers & Pages → D1 → Create database)
- Name: `d1-studio-db` (or any name you like)
- Note the **Database ID** shown after creation

**KV namespace** (Workers & Pages → KV → Create namespace)
- Name: `D1_STUDIO_KV`
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
| `D1_DATABASE_NAME` | e.g. `d1-studio-db` |
| `D1_DATABASE_ID` | The D1 Database ID from Step 1 |
| `KV_NAMESPACE_ID` | The KV Namespace ID from Step 1 |

---

### Step 3 — Configure Cloudflare Worker secrets & variables

These values are sensitive or deployment-specific and are set **directly in the Cloudflare dashboard**, not in GitHub.

Go to **Workers & Pages → d1-studio → Settings → Variables and Secrets**:

**Secrets** (type: Secret):

| Name | How to generate |
|------|----------------|
| `JWT_SECRET` | Any random 64-char string — e.g. `openssl rand -hex 32` |
| `ENCRYPTION_KEY` | 64-char hex (32 bytes) — e.g. `openssl rand -hex 32` |
| `SETUP_SECRET` | Any random string — e.g. `openssl rand -hex 16` |

**Variables** (type: Text):

| Name | Value |
|------|-------|
| `APP_URL` | Your Worker URL, e.g. `https://d1-studio.yourname.workers.dev` or your custom domain |
| `TABLE_PREFIX` | *(Optional)* Prefix for all internal D1 tables, e.g. `kp` → tables become `kp_users`, `kp_settings`, etc. Must be set **before** visiting the setup URL. Cannot be changed after initialisation. |

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

After the first successful deployment, visit this URL **once**:

```
https://<your-domain>/api/setup/<SETUP_SECRET>
```

Expected response:

```json
{ "ok": true, "message": "Database initialised successfully. You can now register at /register — the first user becomes admin." }
```

> The endpoint is idempotent — safe to call multiple times.

---

### Step 6 — Create the admin account

Visit `https://<your-domain>/register`. The **first registered user automatically becomes admin**.

Afterwards:
- Disable registration in **Admin → Settings** if needed
- Add queryable D1 databases in **Admin → Databases**
- Grant users access in **Admin → Databases → Permissions**

---

## Adding a Queryable D1 Database

D1 databases must be bound to the Worker at deploy time.

1. Add a `[[d1_databases]]` entry to `worker/wrangler.toml`:

   ```toml
   [[d1_databases]]
   binding = "QUERY_DB_1"
   database_name = "my-app-db"
   database_id   = "xxxx-xxxx-xxxx"
   ```

2. Push to `main` — the Actions workflow will redeploy automatically.

3. In the Admin Panel → **Databases**, click **Add database** and enter the binding name (`QUERY_DB_1`).

4. In **Databases → Permissions**, grant access to users.

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

Apply local D1 schema via the setup endpoint:

```
http://localhost:8787/api/setup/dev-setup-secret
```

---

## Configuration Reference

### GitHub Secrets & Variables

| Name | Where | Description |
|------|-------|-------------|
| `CLOUDFLARE_API_TOKEN` | Secret | Wrangler deploy authentication |
| `CLOUDFLARE_ACCOUNT_ID` | Variable | Cloudflare account ID |
| `CF_D1_DATABASE_NAME` | Variable | D1 database name (e.g. `d1-studio-db`) |
| `CF_D1_DATABASE_ID` | Variable | D1 database ID |
| `CF_KV_NAMESPACE_ID` | Variable | KV namespace ID |

### Cloudflare Dashboard (set manually)

| Name | Type | Description |
|------|------|-------------|
| `JWT_SECRET` | Secret | Signs access + refresh JWTs (HS256) |
| `ENCRYPTION_KEY` | Secret | 64-char hex — AES-GCM key for TOTP secrets |
| `SETUP_SECRET` | Secret | Protects `GET /api/setup/:secret` |
| `APP_URL` | Variable | Full URL of your deployment |
| `TABLE_PREFIX` | Variable | *(Optional)* Prefix for internal tables (e.g. `kp`). Set before first setup run. |

---

## Tech Stack

| | |
|---|---|
| **Runtime** | Cloudflare Workers |
| **API** | [Hono](https://hono.dev) v4 |
| **Database** | [Cloudflare D1](https://developers.cloudflare.com/d1/) (SQLite) |
| **KV** | [Cloudflare KV](https://developers.cloudflare.com/kv/) |
| **Frontend** | React 19, Vite, Tailwind CSS v3 |
| **SQL Editor** | CodeMirror 6 + `@codemirror/lang-sql` |
| **Auth** | PBKDF2-SHA256 passwords, HS256 JWTs, WebAuthn passkeys |
| **2FA** | TOTP (otpauth), Email OTP, Passkey |
| **Email** | [Resend](https://resend.com) or custom SMTP |
| **Deploy** | `wrangler deploy` |

---

## License

MIT
