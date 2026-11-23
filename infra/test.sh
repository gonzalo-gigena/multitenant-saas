#!/bin/sh
# Migration lint, RLS guard, tenant isolation suite and role matrix against real Postgres. What CI runs, and what you can run locally.
# Like ci-stack.sh, it ends with `down -v`, so it wipes this project's local database.
# Usage: sh infra/test.sh
set -eu
compose="docker compose -f compose.yaml"

sh common/scripts/check-migrations.sh

trap '$compose down -v --remove-orphans >/dev/null 2>&1' EXIT
$compose up -d --wait --build || { $compose logs; exit 1; }
$compose run --rm --no-deps seed

echo "== RLS guard"
$compose exec -T db sh -c 'psql -q -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"' < infra/db/rls-guard.sql

echo "== Isolation suite + role-permission matrix"
# The api image and env (so app_user), with only the test files (and the README, whose
# role matrix roles.js checks) mounted.
$compose run --rm --no-deps -T -v "$PWD/apps/api/integration:/app/integration:ro" -v "$PWD/README.md:/app/README.md:ro" \
  api node --test 'integration/*.js' || { $compose logs --tail 50 api; exit 1; }
