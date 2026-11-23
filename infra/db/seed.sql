-- Idempotent: safe to run any number of times. Runs as the owner, so RLS doesn't apply.
INSERT INTO greetings (message)
SELECT 'Hello from the seed data'
WHERE NOT EXISTS (SELECT 1 FROM greetings);

-- Two tenants with one owner each. Fixed IDs: apps/api/integration/isolation.js uses them.
-- Both users sign in with the password `demo-password` (the argon2id hash below).
INSERT INTO tenants (id, slug, name) VALUES
  ('00000000-0000-7000-8000-00000000000a', 'demo', 'Demo Barbershop'),
  ('00000000-0000-7000-8000-00000000000b', 'acme', 'Acme Clinic')
ON CONFLICT DO NOTHING;

INSERT INTO users (id, email, password_hash) VALUES
  ('00000000-0000-7000-8000-0000000000a1', 'alice@demo.test', '$argon2id$v=19$m=19456,t=2,p=1$UCnpifVz7DnRAZcd3DFVPQ$hiGo9Vhz3c1TFUmz4SlSuWyZqq6co6BGVYokUXC5lX4'),
  ('00000000-0000-7000-8000-0000000000b1', 'bob@acme.test', '$argon2id$v=19$m=19456,t=2,p=1$UCnpifVz7DnRAZcd3DFVPQ$hiGo9Vhz3c1TFUmz4SlSuWyZqq6co6BGVYokUXC5lX4')
ON CONFLICT (id) DO UPDATE SET password_hash = EXCLUDED.password_hash;

INSERT INTO memberships (tenant_id, user_id, role) VALUES
  ('00000000-0000-7000-8000-00000000000a', '00000000-0000-7000-8000-0000000000a1', 'owner'),
  ('00000000-0000-7000-8000-00000000000b', '00000000-0000-7000-8000-0000000000b1', 'owner')
ON CONFLICT DO NOTHING;

INSERT INTO services (tenant_id, id, name, duration_min, price_cents) VALUES
  ('00000000-0000-7000-8000-00000000000a', '00000000-0000-7000-8000-0000000000a2', 'Haircut', 30, 2500)
ON CONFLICT DO NOTHING;
