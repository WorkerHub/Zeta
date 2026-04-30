# D1 Studio — Product Specification

## Overview

A self-hosted SQL query interface for Cloudflare D1 databases, running entirely on Cloudflare infrastructure. Target audience: the owner and a small group of friends who want to run SQL queries and practice SQL.

---

## Architecture

| Layer | Technology |
|-------|------------|
| Runtime | Cloudflare Workers |
| Framework | Hono.js v4 |
| App database | D1 (SQLite) — users, sessions, settings, permissions, history |
| Query targets | Additional D1 bindings registered by admin |
| Session/KV | Cloudflare KV — JWTs, 2FA tokens, rate-limit counters |
| Frontend | React 19 + Vite + TailwindCSS (SPA served via Workers Assets) |
| Deployment | Single `wrangler deploy` |

---

## Features

### Authentication
- Email + password (PBKDF2-SHA256, 210k iterations)
- JWT dual-token: 15-min access token (in-memory) + 7-day refresh token (HttpOnly cookie)
- Email verification on registration (toggle in admin settings)
- Forgot/reset password via email link (1h expiry)
- Optional 2FA per user: TOTP (RFC 6238), Email OTP
- Optional passkey (WebAuthn via @simplewebauthn/server)
- Global 2FA enforcement toggle in admin settings
- IP-based login rate limiting (10 attempts per 15 min)
- Registration open/close toggle

### SQL Editor
- Full SQL input (no query builder)
- Ctrl/Cmd+Enter to run
- Read-only by default; write access granted per-user per-database by admin
- Forbidden: DROP/TRUNCATE, ATTACH/DETACH DATABASE, PRAGMA writes
- Results table with NULL display, JSON values highlighted
- Execution time and row count shown after each query
- Query history panel (last 50 queries per database)
- History stored in app DB (non-blocking via `waitUntil`)

### Multi-Database Support
- Admin registers additional D1 bindings (must exist in wrangler.toml)
- Per-user per-database permissions: `read` or `write`
- Admins always have write access to all registered databases
- Members only see databases they have been granted access to

### Admin Panel
- **Users**: list, search, change role (admin/member), delete
- **Databases**: register/unregister D1 bindings, toggle active, manage permissions per database
- **Settings**: app name, registration toggle, email verification toggle, 2FA enforcement, email provider (Resend or SMTP), from address, API key/credentials

### Profile & Security
- View account info
- Change password
- Add/remove TOTP authenticator (QR code + manual entry)
- Add/remove passkeys (WebAuthn)

---

## Non-Functional Requirements

| Requirement | Target |
|-------------|--------|
| Target QPS | ~10 |
| Latency (p50) | < 200ms for simple queries |
| Database size | Up to 5 GB per D1 instance |
| Security headers | X-Content-Type-Options, X-Frame-Options, HSTS, Referrer-Policy |
| OWASP | Input validation, parameterized queries, no user enumeration, constant-time password compare |
| Deployments | Zero-downtime via Cloudflare Workers rollout |

---

## Constraints

- **Cloudflare-only**: no external compute; only external services are email (Resend/MailChannels) and optional Google Fonts
- **No raw TCP SMTP**: CF Workers doesn’t support TCP; SMTP requires MailChannels or Resend HTTP API
- **bcrypt not supported**: PBKDF2 used instead (WebCrypto-native)
- **Queryable D1 must be bound at deploy time**: adding a new target DB requires a wrangler redeploy

---

## Open Items / Future Work

- Export query results to CSV/JSON
- Saved queries / snippets
- Table schema browser (sidebar showing tables + columns)
- Multi-statement execution (batch)
- Usage metrics dashboard
- Audit log UI page (data already stored in `audit_logs` table)
