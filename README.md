# Multi-tenant SaaS

Appointment booking for small businesses, with isolated tenants, billing, an audit log and a public API.

The step-by-step build plan is in [PLAN.md](PLAN.md).

> **Status:** skeleton. The stack runs, scales and passes CI. The product itself isn't built yet.

## Run it

```bash
git clone --recurse-submodules https://github.com/gonzalo-gigena/multitenant-saas.git
cd multitenant-saas
cp .env.example .env
docker compose up --watch
```

Open http://localhost:8080. Needs only Docker with Compose v2. Code changes reload
automatically (Compose Watch). On Windows, clone inside the WSL filesystem, not `/mnt/c`.

Cloned without `--recurse-submodules`? Run `git submodule update --init`.

## Everyday commands

| What | Command |
|---|---|
| Seed demo data | `docker compose run --rm seed` |
| SQL shell | `docker compose exec db psql -U app app` |
| Scale the api | `docker compose up -d --scale api=3` |
| Prove scaling works | `sh common/scripts/smoke.sh 3` |
| Run exactly what CI runs | `sh common/scripts/ci-stack.sh 3` |
| Load test at 1, 2, 4 replicas | `sh common/scripts/scale.sh` |
| Metrics (Prometheus) | `docker compose --profile observability up -d`, then http://localhost:9090 |
| Unit tests | `docker run --rm -v "$PWD/apps/api:/app" -w /app node:26.13-bookworm-slim node --test` |
| New migration | add `infra/db/migrations/00000N_name.up.sql` + `.down.sql`, restart |
| Update shared code | `git submodule update --remote common` |
| Reset everything | `docker compose down -v` |

## Fakes (from common)

These start in dev and CI (`COMPOSE_PROFILES=fakes`), never in production.
Full reference: [`common/README.md`](common/README.md).

| Service | What |
|---|---|
| `payments-mock` | Fake payment provider. Checkout pages at http://localhost:8090. The api calls `http://payments-mock:8090`, and webhooks go to `PAYMENTS_WEBHOOK_URL`. |
| `mailpit` | Catches all email. Send to `smtp://mailpit:1025`, read at http://localhost:8025. |
| `webhook-sink` | Records webhooks sent to `http://webhook-sink:8091/hooks/<name>`. View at http://localhost:8091. |

## Architecture

```mermaid
flowchart LR
  staff["Business staff<br/>app.localhost:8080"]
  customers["Customers<br/>acme.localhost:8080"]
  integrations["Tenant integrations<br/>API keys"]
  subgraph stack["docker compose"]
    caddy["Caddy :8080<br/>*.localhost → tenant"]
    web["web<br/>Next.js"]
    api["api ×N"]
    worker["worker ×N<br/>pg-boss jobs"]
    bouncer["PgBouncer"]
    db[("Postgres<br/>shared schema + RLS")]
    redis[("Redis<br/>rate limits, tenant cache")]
    minio[("MinIO<br/>uploads")]
    pay["payments-mock<br/>(fake billing)"]
    mail["Mailpit<br/>(fake email)"]
    sink["webhook-sink<br/>(fake receiver)"]
  end
  staff --> caddy
  customers -.-> caddy
  integrations -.->|"public API"| caddy
  caddy -.-> web
  caddy --> api
  api -->|"direct today"| db
  api -.->|"tenant set per transaction"| bouncer
  bouncer -.-> db
  worker -.->|"direct connection"| db
  api -.-> redis
  api -.-> minio
  api <-.->|"checkout, signed webhooks"| pay
  worker -.-> mail
  worker -.->|"signed outgoing webhooks"| sink
  class customers,integrations,web,worker,bouncer,redis,minio planned
  classDef planned stroke-dasharray: 5 5
```

Solid boxes and arrows run today. Dashed ones are planned in [PLAN.md](PLAN.md).

All tenants share one schema. Postgres Row-Level Security filters every query by the tenant set at the start of the transaction, so a forgotten `WHERE tenant_id` in app code can't leak data.

## Stack

- **api:** Node 26 (`node:http` + `pg`), plain JavaScript. Stateless, so it scales with `--scale api=N`.
- **Caddy:** the only service with a host port. It load-balances `/api/*` across every
  replica (`import lb api 8080`, from common) and serves `apps/web`.
- **Postgres 18:** migrations run once before the api starts (`golang-migrate`).
- **common/:** git submodule with the shared fakes, scripts, Caddy snippet and Prometheus.
  See [portfolio-common](common/README.md).

## Deploy (one VM)

```bash
docker compose -f compose.yaml -f compose.prod.yaml up -d
```

The server's `.env` needs `SITE_ADDRESS`, `IMAGE_REPO`, `TAG`, a strong password, and no `fakes`
profile. Caddy gets TLS automatically. CI pushes multi-arch images to GHCR on every merge to `main`.

## Decisions & tradeoffs

| Decision | Chosen | Rejected | Why, and what it costs |
|---|---|---|---|
| Tenant isolation | Shared schema with Row-Level Security (`FORCE`, policies on `app.tenant_id`) | Schema per tenant, database per tenant | One migration path and one connection pool for every tenant, and the database enforces isolation instead of every query remembering a `WHERE`. Cost: a small cost per query (to be measured with `EXPLAIN ANALYZE`), and tenants share resources. A large tenant can still move to its own database through a tenant → connection-string table. |
| Setting the tenant | `set_config('app.tenant_id', $1, true)` at the start of each transaction. The app connects as a role without `BYPASSRLS` | A session-level `SET`, or connecting as the table owner | A transaction-local setting is safe with PgBouncer transaction pooling. With no tenant set, `NULLIF` makes every policy return no rows instead of raising an error. |
| Catching leaks | A CI test fails if any table with a `tenant_id` column lacks RLS and `FORCE`, and an isolation suite calls every route as tenant B with tenant A's IDs | Relying on code review | A new table without a policy is the most likely leak, and it's cheap to detect automatically. |
| Double booking a staff member | Exclusion constraint `EXCLUDE USING gist (staff_id WITH =, tstzrange(starts_at, ends_at) WITH &&)` | Check, then insert, in app code | Two simultaneous requests can both pass an app-level check. The constraint can't be raced. |
| Background jobs | pg-boss on Postgres | A Redis queue (BullMQ) | No extra service, and a job can be enqueued in the same transaction as the booking. Jobs carry `tenant_id` and set it the same way requests do. |
| Billing | Webhooks → `subscriptions` → computed `entitlements`, enforced in the API | Hiding buttons in the UI | Limits must hold for API clients too. A failed payment leads to a grace period, then read-only mode, and data is never deleted. |
| Audit log | Append-only table written in the same transaction as the change. `app_user` gets only `INSERT` and `SELECT` | Log files or async events | It can't miss a change, and the app can't edit history. |
| Outgoing webhooks | HMAC-signed and retried by the worker. Resolve the hostname once, reject private ranges, then connect to that exact IP | Fetching the tenant's URL directly | A tenant-supplied URL is an SSRF vector, and resolving twice lets DNS rebinding through. |
| Routing | Dashboard on `app.localhost` with the tenant in the path. Subdomains only for public booking pages | A subdomain per tenant for the dashboard too | The session cookie stays on one host. Browsers resolve `*.localhost` without editing `/etc/hosts`. |
| Load balancing | Caddy `dynamic a` upstreams (the `lb` snippet in `common/`) | `reverse_proxy api:8080`, Traefik | Caddy re-reads Docker DNS every 5 s, so `--scale api=N` needs no config change and no Docker socket mount. A plain `reverse_proxy api:8080` is a single upstream to Caddy and doesn't reliably spread load. |
| Migrations | A one-shot `migrate` service that finishes before the api starts | Each replica migrating on boot | Replicas starting together would race on the same migration. |

Rows for parts that aren't built yet record the plan's choice. Each one gets confirmed or revised when that phase is built.

## Scaling

### Measured

The skeleton only, not the product yet: k6 with 20 virtual users for 20 s against `GET /api/hello`, which reads one row from Postgres through Caddy. Run on an Apple M1 laptop with 8 CPUs and 8 GB given to Docker, with the dev override left out:

```bash
COMPOSE_FILE=compose.yaml sh common/scripts/scale.sh
```

| api replicas | req/s | p95 latency | failed |
|---|---|---|---|
| 1 | 12,317 | 3.14 ms | 0.00% |
| 2 | 10,721 | 3.76 ms | 0.00% |
| 4 | 11,059 | 3.68 ms | 0.00% |

4 replicas served 0.9× the requests of 1. At 1 replica the api used about one core, while Caddy, Postgres and k6 together used about four of the laptop's eight (sampled with `docker stats` during the run). The api isn't the bottleneck on one machine, so more replicas only compete for the same CPUs. Replicas pay off when the api is the busiest process, and a hello endpoint doing one query isn't.

### How each part scales

| Part | Scales by | Limit |
|---|---|---|
| `api` | `--scale api=N` (stateless) | Postgres connections. Add PgBouncer past ~2 replicas. |
| `worker` | `--scale worker=N` | pg-boss claims jobs with `SKIP LOCKED`, so workers don't block each other |
| Postgres | One primary | Every tenant shares it, plus the RLS cost on every query |
| Redis | One instance | Rate limits and the tenant config cache |

### Where it breaks next

- **Postgres connections.** PgBouncer in transaction mode once there are more than ~2 api replicas. pg-boss keeps its own direct connection.
- **One noisy tenant.** Per-tenant rate limits first. Then move that tenant to its own database through a tenant → connection-string routing table.
- **Tenant config read on every request** (plan, timezone, branding). Cache it in Redis and invalidate on change.

Phase 8 adds the real test: `--scale api=3 --scale worker=2` with k6 driving 200 tenants of booking traffic, plus the RLS cost from `EXPLAIN ANALYZE` with and without policies.
