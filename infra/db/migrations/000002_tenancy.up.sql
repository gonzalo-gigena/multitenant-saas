SET lock_timeout = '3s';

-- Roles: migrations run as the owner (POSTGRES_USER). The api connects as app_user,
-- which is never a superuser and never has BYPASSRLS. Its password is set by
-- infra/db/init/app-user.sh, so it never lands in git; this only covers databases
-- where that script didn't run.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    CREATE ROLE app_user LOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
END $$;
GRANT USAGE ON SCHEMA public TO app_user;
GRANT SELECT ON greetings TO app_user;

-- Global tables, looked up before a tenant is known. app_user gets no grants on them:
-- it reaches them only through the SECURITY DEFINER function below.
CREATE TABLE tenants (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  email text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Tenant-owned tables. tenant_id defaults to the transaction's tenant, so inserts
-- never pass it. Primary keys lead with tenant_id, and foreign keys between tenant
-- tables include it: a plain FK check bypasses RLS, so without tenant_id in it a
-- tenant could point at another tenant's row by guessing its ID.
CREATE TABLE memberships (
  tenant_id uuid NOT NULL DEFAULT NULLIF(current_setting('app.tenant_id', true), '')::uuid REFERENCES tenants (id),
  user_id uuid NOT NULL REFERENCES users (id),
  role text NOT NULL DEFAULT 'owner' CHECK (role IN ('owner', 'admin', 'staff')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id)
);
CREATE INDEX memberships_user_id ON memberships (user_id);

CREATE TABLE services (
  tenant_id uuid NOT NULL DEFAULT NULLIF(current_setting('app.tenant_id', true), '')::uuid REFERENCES tenants (id),
  id uuid NOT NULL DEFAULT uuidv7(),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  duration_min int NOT NULL CHECK (duration_min BETWEEN 1 AND 1440),
  price_cents int NOT NULL CHECK (price_cents >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);

CREATE TABLE appointments (
  tenant_id uuid NOT NULL DEFAULT NULLIF(current_setting('app.tenant_id', true), '')::uuid,
  id uuid NOT NULL DEFAULT uuidv7(),
  service_id uuid NOT NULL,
  customer_name text NOT NULL CHECK (length(customer_name) BETWEEN 1 AND 200),
  starts_at timestamptz NOT NULL CHECK (isfinite(starts_at)),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, service_id) REFERENCES services (tenant_id, id)
);
CREATE INDEX appointments_tenant_starts_at ON appointments (tenant_id, starts_at);
CREATE INDEX appointments_tenant_service ON appointments (tenant_id, service_id);

-- RLS on every table with tenant_id. infra/db/rls-guard.sql fails CI if one is missed.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['memberships', 'services', 'appointments'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, DELETE ON services, appointments TO app_user;

-- The one pre-tenant lookup Phase 1 needs: which tenant does this slug name, if the
-- user is a member? Returns NULL otherwise, so "no such tenant" and "not yours" look
-- the same. Runs as the owner (a superuser here), which skips RLS on memberships.
CREATE FUNCTION member_tenant_id(p_slug text, p_user_id uuid) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT t.id FROM public.tenants t
  JOIN public.memberships m ON m.tenant_id = t.id
  WHERE t.slug = p_slug AND m.user_id = p_user_id
$$;
REVOKE ALL ON FUNCTION member_tenant_id(text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION member_tenant_id(text, uuid) TO app_user;
