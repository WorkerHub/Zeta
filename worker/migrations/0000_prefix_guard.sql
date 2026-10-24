-- Guard for the wrangler d1 migrations path: refuse to apply these migrations to a database
-- that already hosts an initialised Zeta schema somewhere else. These migrations only ever
-- create UNPREFIXED Zeta tables (users, settings, ...), so:
--   * a PREFIXED family — 9 or more of the 11 Zeta tables sharing one prefix (9 = the table
--     count of the oldest complete Zeta schema, 0001) — means this database was initialised
--     through POST /api/setup with TABLE_PREFIX configured. Applying the migrations would add a
--     second, parallel unprefixed schema and strand the existing data behind it.
--   * an UNPREFIXED family with no migrations recorded in d1_migrations was also initialised
--     through POST /api/setup (TABLE_PREFIX set to an empty string), not by these migrations.
-- In both cases upgrade by re-running POST /api/setup after deploying instead.
-- Detection looks only for the 11 Zeta table names. Other projects' tables sharing this database
-- (SL_*, eNotify_*, ...) are never read beyond sqlite_master's name column, counted or touched.
-- Keep this in sync with detectExistingTableFamily() in worker/src/lib/db.ts (same family, same
-- threshold of 9) — this file exists only because wrangler runs plain SQL, outside the worker.
-- (wrangler creates the d1_migrations tracking table before applying anything; the IF NOT EXISTS
-- below mirrors that precondition so the guard also runs standalone.)

CREATE TABLE IF NOT EXISTS d1_migrations (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT UNIQUE,
  applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE zeta_prefix_guard (
  prefixed_family TEXT
    CHECK (prefixed_family <> 'REFUSED - this D1 database already contains an initialised Zeta schema under a table prefix (9 or more of the 11 Zeta family tables share one prefix, e.g. ZETA_users for TABLE_PREFIX=ZETA). These migrations only create unprefixed Zeta tables, so applying them here would add a second parallel schema and strand the existing data. Upgrade such a deployment by re-running POST /api/setup after deploying instead - do not apply migrations here.'),
  untracked_unprefixed TEXT
    CHECK (untracked_unprefixed <> 'REFUSED - this D1 database already contains an unprefixed Zeta schema that was not created by these migrations (d1_migrations records none). It was most likely initialised through POST /api/setup with an empty TABLE_PREFIX, so upgrade it by re-running POST /api/setup after deploying instead of applying migrations.')
);

INSERT INTO zeta_prefix_guard (prefixed_family, untracked_unprefixed) VALUES (
  CASE WHEN EXISTS (
    SELECT 1 FROM sqlite_master
     WHERE type = 'table'
       AND (name GLOB '*_users' OR name GLOB '*_totp_credentials' OR name GLOB '*_passkey_credentials'
            OR name GLOB '*_d1_databases' OR name GLOB '*_user_database_permissions' OR name GLOB '*_query_history'
            OR name GLOB '*_settings' OR name GLOB '*_audit_logs' OR name GLOB '*_notebooks'
            OR name GLOB '*_notebook_runs' OR name GLOB '*_rate_limits')
     GROUP BY CASE
       WHEN name GLOB '*_users' THEN substr(name, 1, length(name) - length('_users'))
       WHEN name GLOB '*_totp_credentials' THEN substr(name, 1, length(name) - length('_totp_credentials'))
       WHEN name GLOB '*_passkey_credentials' THEN substr(name, 1, length(name) - length('_passkey_credentials'))
       WHEN name GLOB '*_d1_databases' THEN substr(name, 1, length(name) - length('_d1_databases'))
       WHEN name GLOB '*_user_database_permissions' THEN substr(name, 1, length(name) - length('_user_database_permissions'))
       WHEN name GLOB '*_query_history' THEN substr(name, 1, length(name) - length('_query_history'))
       WHEN name GLOB '*_settings' THEN substr(name, 1, length(name) - length('_settings'))
       WHEN name GLOB '*_audit_logs' THEN substr(name, 1, length(name) - length('_audit_logs'))
       WHEN name GLOB '*_notebooks' THEN substr(name, 1, length(name) - length('_notebooks'))
       WHEN name GLOB '*_notebook_runs' THEN substr(name, 1, length(name) - length('_notebook_runs'))
       WHEN name GLOB '*_rate_limits' THEN substr(name, 1, length(name) - length('_rate_limits'))
     END
    HAVING count(*) >= 9
  ) THEN
    'REFUSED - this D1 database already contains an initialised Zeta schema under a table prefix (9 or more of the 11 Zeta family tables share one prefix, e.g. ZETA_users for TABLE_PREFIX=ZETA). These migrations only create unprefixed Zeta tables, so applying them here would add a second parallel schema and strand the existing data. Upgrade such a deployment by re-running POST /api/setup after deploying instead - do not apply migrations here.'
  ELSE 'ok' END,
  CASE WHEN (
    (SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name IN
      ('users', 'totp_credentials', 'passkey_credentials', 'd1_databases',
       'user_database_permissions', 'query_history', 'settings', 'audit_logs',
       'notebooks', 'notebook_runs', 'rate_limits')) >= 9
    AND NOT EXISTS (SELECT 1 FROM d1_migrations)
  ) THEN
    'REFUSED - this D1 database already contains an unprefixed Zeta schema that was not created by these migrations (d1_migrations records none). It was most likely initialised through POST /api/setup with an empty TABLE_PREFIX, so upgrade it by re-running POST /api/setup after deploying instead of applying migrations.'
  ELSE 'ok' END
);

DROP TABLE zeta_prefix_guard;
