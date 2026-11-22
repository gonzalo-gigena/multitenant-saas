#!/bin/sh
# Runs once, when the pgdata volume is created. Creates the role the api connects as.
# Grants live in the migrations. Existing volume from before Phase 1? `docker compose down -v`.
: "${APP_DB_PASSWORD:?}"
psql -v ON_ERROR_STOP=1 -v pw="$APP_DB_PASSWORD" -U "$POSTGRES_USER" -d "$POSTGRES_DB" <<'SQL'
CREATE ROLE app_user LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD :'pw';
SQL
