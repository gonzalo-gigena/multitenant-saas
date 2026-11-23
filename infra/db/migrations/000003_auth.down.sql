SET lock_timeout = '3s';

DROP FUNCTION create_user(text, text), ensure_user(text), login_lookup(text), auth_session(bytea),
  end_session(bytea), user_tenants(uuid), create_tenant(text, text, uuid), tenant_members();
REVOKE SELECT, INSERT, UPDATE, DELETE ON memberships FROM app_user;
DROP TABLE invites, sessions;
ALTER TABLE users DROP COLUMN password_hash;
