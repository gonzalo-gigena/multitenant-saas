SET lock_timeout = '3s';

-- Phase 2: sign-in, sessions, roles, invites. Same rules as 000002: global tables are
-- reached through SECURITY DEFINER functions, tenant tables get RLS + FORCE.

-- Nullable and no default, so it is instant: magic-link users have no password.
ALTER TABLE users ADD COLUMN password_hash text;

-- The cookie holds a random token. Only its SHA-256 is stored, so a leaked table
-- (or backup) opens no sessions. app_user may INSERT but not read it.
CREATE TABLE sessions (
  id bytea PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user_id ON sessions (user_id);
GRANT INSERT ON sessions TO app_user;

-- Pending invites. The emailed token signs (tenant_id, id); the row is what expires and
-- what accepting deletes, so a link works once and revoking it is a DELETE.
CREATE TABLE invites (
  tenant_id uuid NOT NULL DEFAULT NULLIF(current_setting('app.tenant_id', true), '')::uuid REFERENCES tenants (id),
  id uuid NOT NULL DEFAULT uuidv7(),
  email text NOT NULL CHECK (email ~ '^[^\s@<>]+@[^\s@<>]+$' AND email = lower(email) AND length(email) <= 254),
  role text NOT NULL CHECK (role IN ('admin', 'staff')), -- owners are made by promotion, never by link
  invited_by uuid NOT NULL REFERENCES users (id),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '7 days',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);
ALTER TABLE invites ENABLE ROW LEVEL SECURITY;
ALTER TABLE invites FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON invites
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT, DELETE ON invites TO app_user;

-- Members are managed inside a tenant now. RLS (since 000002) keeps it to one tenant.
GRANT SELECT, INSERT, UPDATE, DELETE ON memberships TO app_user;

-- Pre-tenant lookups. Each returns only what its caller needs.
CREATE FUNCTION create_user(p_email text, p_password_hash text) RETURNS uuid
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
  INSERT INTO public.users (email, password_hash) VALUES (lower(p_email), p_password_hash) RETURNING id
$$;

-- Magic link: sign in, or sign up on first use.
CREATE FUNCTION ensure_user(p_email text) RETURNS uuid
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
  INSERT INTO public.users (email) VALUES (lower(p_email))
  ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email
  RETURNING id
$$;

CREATE FUNCTION login_lookup(p_email text) RETURNS TABLE (id uuid, password_hash text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT id, password_hash FROM public.users WHERE email = lower(p_email)
$$;

CREATE FUNCTION auth_session(p_id bytea) RETURNS TABLE (user_id uuid, email text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT u.id, u.email FROM public.sessions s JOIN public.users u ON u.id = s.user_id
  WHERE s.id = p_id AND s.expires_at > now()
$$;

CREATE FUNCTION end_session(p_id bytea) RETURNS void
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
  DELETE FROM public.sessions WHERE id = p_id OR (user_id = (SELECT user_id FROM public.sessions WHERE id = p_id) AND expires_at <= now())
$$;

-- The tenant switcher.
CREATE FUNCTION user_tenants(p_user_id uuid) RETURNS TABLE (id uuid, slug text, name text, role text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT t.id, t.slug, t.name, m.role FROM public.memberships m JOIN public.tenants t ON t.id = m.tenant_id
  WHERE m.user_id = p_user_id ORDER BY t.name
$$;

CREATE FUNCTION create_tenant(p_slug text, p_name text, p_owner uuid) RETURNS uuid
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
  WITH t AS (INSERT INTO public.tenants (slug, name) VALUES (p_slug, p_name) RETURNING id)
  INSERT INTO public.memberships (tenant_id, user_id, role) SELECT id, p_owner, 'owner' FROM t RETURNING tenant_id
$$;

-- Member list with emails, for the current tenant only (it runs as the owner, so it
-- filters by app.tenant_id itself instead of relying on RLS).
CREATE FUNCTION tenant_members() RETURNS TABLE (id uuid, email text, role text, created_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT u.id, u.email, m.role, m.created_at FROM public.memberships m JOIN public.users u ON u.id = m.user_id
  WHERE m.tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid ORDER BY m.created_at
$$;

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['create_user(text, text)', 'ensure_user(text)', 'login_lookup(text)', 'auth_session(bytea)',
                           'end_session(bytea)', 'user_tenants(uuid)', 'create_tenant(text, text, uuid)', 'tenant_members()'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO app_user', f);
  END LOOP;
END $$;
