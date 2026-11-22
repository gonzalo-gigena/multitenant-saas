-- CI guard: fails if any table with a tenant_id column breaks the Phase 1 rules, or if
-- the api role could bypass RLS. Needs no list of tables, so a new one can't be missed.
-- docker compose exec -T db sh -c 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"' < infra/db/rls-guard.sql
DO $$
DECLARE bad text;
BEGIN
  SELECT string_agg(c.oid::regclass::text, ', ') INTO bad
  FROM pg_class c
  JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped
  WHERE c.relkind IN ('r', 'p')
    AND c.relnamespace NOT IN ('pg_catalog'::regnamespace, 'information_schema'::regnamespace)
    AND NOT (
      c.relrowsecurity AND c.relforcerowsecurity
      AND a.attnotnull AND a.atttypid = 'uuid'::regtype
      AND EXISTS (SELECT FROM pg_index i WHERE i.indrelid = c.oid AND i.indkey[0] = a.attnum)
      -- Exactly one policy: permissive policies are ORed, so a second one can open a hole.
      AND (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid) = 1
      AND EXISTS (
        SELECT FROM pg_policy p
        WHERE p.polrelid = c.oid AND p.polname = 'tenant_isolation' AND p.polcmd = '*'
          AND pg_get_expr(p.polqual, c.oid) LIKE '%app.tenant_id%'
          AND pg_get_expr(p.polwithcheck, c.oid) LIKE '%app.tenant_id%'));
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'tenant tables need tenant_id uuid NOT NULL, an index leading with it, RLS + FORCE and only the tenant_isolation policy: %', bad;
  END IF;

  -- A view reads as its owner, and so skips RLS, unless it is security_invoker. Materialized views always do.
  SELECT string_agg(c.oid::regclass::text, ', ') INTO bad
  FROM pg_class c
  WHERE c.relkind IN ('v', 'm') AND c.relnamespace = 'public'::regnamespace
    AND has_table_privilege('app_user', c.oid, 'SELECT')
    AND NOT coalesce(c.reloptions && ARRAY['security_invoker=true', 'security_invoker=on'], false);
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'views that app_user can read past RLS: %', bad;
  END IF;

  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user' AND NOT rolsuper AND NOT rolbypassrls) THEN
    RAISE EXCEPTION 'app_user is missing, a superuser, or has BYPASSRLS';
  END IF;
  IF EXISTS (SELECT FROM pg_auth_members WHERE member = 'app_user'::regrole)
     OR EXISTS (SELECT FROM pg_class WHERE relowner = 'app_user'::regrole) THEN
    RAISE EXCEPTION 'app_user must not own relations or be a member of another role';
  END IF;
  RAISE NOTICE 'rls guard: ok';
END $$;
