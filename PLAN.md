# 05 — Multi-tenant SaaS (appointment booking for small businesses)

> `payments-mock`, `mailpit`, `webhook-sink` come from the shared `common` submodule, already wired into `compose.yaml`.

A real product, not a template: barbershops, clinics or tutors sign up, add staff
and services, and their customers book online. Every business (tenant) is isolated,
billed by plan, and audited. Follows the shared baseline
(`common/docs/baseline.md`).

**What it proves:** tenant isolation, authorization, billing, a public API,
outgoing webhooks. This is the closest to everyday product work.

## Stack

| Service | Tech | Scales? |
|---|---|---|
| `web` | Next.js (App Router): dashboard + public booking pages | yes |
| `api` | Node 22 + Fastify + Drizzle ORM, OpenAPI generated | yes, stateless |
| `worker` | same codebase, `pg-boss` queue (Postgres-backed, no extra service) | yes |
| `postgres` | Postgres 17 with Row-Level Security | single primary |
| `pgbouncer` | transaction pooling | — |
| `redis` | rate limits, short-lived cache | single |
| `minio` | S3-compatible storage for logos/uploads | — |
| `mailpit` | email locally | — |
| `payments-mock` | default billing provider. Stripe/Mercado Pago test mode is opt-in | — |
| `caddy` | `*.localhost` wildcard → tenant subdomains | — |

**Routing:** the dashboard lives on `app.localhost:8080` with the tenant in the path
(`/t/acme/...`), so the session cookie stays on one host. Only public booking pages
use subdomains (`acme.localhost:8080`). Chrome and Firefox resolve `*.localhost` to
127.0.0.1 with no `/etc/hosts` change. Check Safari yourself. It does not work inside
containers, so Playwright or k6 running in Docker call Caddy directly and set the
`Host` header explicitly.

**Scope:** build phases 0–5 first. Magic link, SSO, custom domains, data export and
tenant deletion are stretch goals. In production, wildcard TLS for `*.yourapp.com`
needs a Caddy build with a DNS-provider plugin (xcaddy). Customer custom domains need
on-demand TLS with an `ask` endpoint, so strangers can't make you issue certificates.

## Steps

### Phase 0 — Scaffold
1. Baseline + Caddy wildcard routing that passes the `Host` header through to `web`/`api`.
- **Done when:** `app.localhost:8080` and `demo.localhost:8080` each reach the right page.

### Phase 1 — Tenancy and isolation
1. Every tenant-owned table has `tenant_id uuid NOT NULL` + an index starting with `tenant_id`.
2. Enable RLS on each table:
   ```sql
   ALTER TABLE appointments ENABLE ROW LEVEL SECURITY;
   ALTER TABLE appointments FORCE ROW LEVEL SECURITY;
   CREATE POLICY tenant_isolation ON appointments
     USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
     WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
   ```
3. The app connects as role `app_user` (no superuser, no `BYPASSRLS`). Migrations
   run as a separate owner role.
4. Each request runs in a transaction that begins with
   `SELECT set_config('app.tenant_id', $1, true)` (transaction-local, so it is
   safe with PgBouncer transaction pooling). With no tenant set, the `NULLIF` makes
   every policy return zero rows instead of raising an error.
5. Some lookups happen before a tenant is known: subdomain → tenant, login, a user's
   list of tenants, public booking pages. Keep `tenants`, `users` and `memberships`
   outside RLS, or reach them only through small `SECURITY DEFINER` functions that
   return just the columns needed.
6. Background jobs carry `tenant_id` in their payload and set `app.tenant_id` the same
   way at the start of every job, because they skip the request path. pg-boss gets a
   direct Postgres connection, not PgBouncer.
7. **Automated guard test:** query `pg_tables` / `pg_class` and fail CI if any table
   with a `tenant_id` column lacks RLS + `FORCE`.
- **Done when:** a test logged in as tenant A gets zero rows of tenant B's
  data through every endpoint, including by guessing IDs.

### Phase 2 — Auth, organizations, roles
1. Sign up / sign in with email + password (argon2id) or magic link. Sessions in
   HTTP-only, `SameSite=Lax` cookies. CSRF protection on mutations.
2. A user can belong to several tenants. Tenant switcher in the UI.
3. Roles: `owner | admin | staff`. A single `can(user, action, resource)` check
   function is used by every route, with tests per role.
4. Invite by email (signed, expiring token).
5. Stretch: OIDC SSO with a Keycloak container (profile `sso`).
- **Done when:** the role-permission matrix in the README is backed by a test for each cell.

### Phase 3 — The product
1. Services (name, duration, price), staff, weekly availability, time off.
2. Public booking page at `<tenant>.localhost:8080`: pick service → staff → slot.
3. No double-booking of a staff member: Postgres exclusion constraint
   `EXCLUDE USING gist (staff_id WITH =, tstzrange(starts_at, ends_at) WITH &&)`
   (needs `btree_gist`). The database enforces it, not app code.
4. Store times in UTC with the tenant's timezone. Write tests for DST transitions.
5. Confirmation + reminder emails (worker, scheduled 24 h before).
- **Done when:** two simultaneous bookings for the same slot result in one success and one clean 409.

### Phase 4 — Billing and plans
1. Plans `free | pro | business` with limits (staff count, bookings/month, custom domain).
2. Checkout + customer portal through the provider (mock by default).
3. Webhooks → `subscriptions` table → `entitlements` computed from it. Verify the
   signature, deduplicate event IDs, process in worker.
4. Feature gating in the API (not just hidden buttons) + usage meters shown in the UI.
5. Handle failed payments: grace period → read-only mode, and never delete data.
- **Done when:** upgrading or downgrading changes the limits immediately, and replaying any webhook has no effect.

### Phase 5 — Audit log
1. Append-only `audit_events(tenant_id, actor_id, action, target, diff jsonb, ip, at)`,
   written in the **same transaction** as the change.
2. `app_user` gets `INSERT`/`SELECT` only on that table (no `UPDATE`/`DELETE`).
   Tenant hard-delete (phase 7) runs as a separate privileged role.
3. UI with filters, plus CSV export.

### Phase 6 — Public API and outgoing webhooks
1. API keys per tenant: show once, store a hash, a visible prefix, and scopes (`read:bookings`, …).
2. Rate limit per key (Redis sliding window), with `X-RateLimit-*` headers.
3. OpenAPI spec generated from route schemas, served with Swagger UI or Scalar.
4. Outgoing webhooks (`booking.created`, …): subscriptions per tenant, an
   HMAC-SHA256 signature header, retries with backoff via worker, a delivery log in the UI.
   Protect against SSRF: resolve the hostname once, reject private, loopback and
   link-local ranges, then connect to that exact IP. Resolving again at connect time
   lets DNS rebinding slip through.
- **Done when:** a sample consumer script verifies signatures and receives events.

### Phase 7 — Data rights and ops
1. Export a tenant's data (ZIP of JSON/CSV) as a background job.
2. Delete a tenant: soft delete → hard delete after 30 days (worker), including MinIO files.
3. Per-tenant rate limits protect everyone from one noisy tenant.

### Phase 8 — Scale
1. `--scale api=3 --scale worker=2` with PgBouncer. k6: 200 tenants × booking traffic.
2. Cache tenant config (plan, timezone, branding) in Redis, and invalidate on change.
3. README: why shared schema + RLS (vs schema-per-tenant vs database-per-tenant), and
   how you'd move one large enterprise tenant to its own database later
   (tenant → connection-string routing table).

## Headline test
The isolation suite: for every API route, create data in tenant A and call the
route as tenant B with A's IDs. Every call must return 404/403 and leak nothing.
It runs alongside the RLS guard test in CI.

## Scaling notes
- RLS adds a small cost per query; measure it (EXPLAIN ANALYZE with/without) and
  put the number in the README.
