SET lock_timeout = '3s';

DROP FUNCTION member_tenant_id(text, uuid);
DROP TABLE appointments, services, memberships, users, tenants;
REVOKE SELECT ON greetings FROM app_user;
REVOKE USAGE ON SCHEMA public FROM app_user;
-- app_user itself stays: roles are cluster-wide and its password comes from initdb.
