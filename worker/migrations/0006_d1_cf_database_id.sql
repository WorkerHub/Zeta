-- Migration: 0006_d1_cf_database_id.sql

-- Query targets moved from Worker bindings to the Cloudflare D1 HTTP API, addressed by their
-- database UUID. Existing rows keep working through their binding until an admin re-links each one
-- from the admin UI (the binding -> UUID mapping is not recoverable at runtime); this only adds the
-- column the re-link writes.
-- NOTE: only for databases created from these migrations. Databases initialised through
-- POST /api/setup (the documented path, including TABLE_PREFIX deployments) get the same change by
-- re-running POST /api/setup after deploying.
ALTER TABLE d1_databases ADD COLUMN cf_database_id TEXT;
