import http from 'node:http';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { observe, render } from './metrics.js';
import { verify, isUuid } from './auth.js';
import { tenantRoutes } from './routes.js';

function env(name, fallback) {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value === '') {
    console.error(JSON.stringify({ level: 'fatal', msg: `missing env var ${name}` }));
    process.exit(1);
  }
  return value;
}

const PORT = Number(env('PORT', '8080'));
const replica = os.hostname();
const pool = new pg.Pool({
  connectionString: env('DATABASE_URL'),
  max: Number(env('DB_POOL_MAX', '10')),
});
const SESSION_SECRET = env('SESSION_SECRET');

const log = (level, msg, extra = {}) =>
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, msg, replica, ...extra }));

// A dropped idle connection emits 'error' on the pool. Unhandled, it crashes the process.
pool.on('error', (err) => log('warn', 'idle db client error', { err: err.message }));

let draining = false;

// ponytail: plain lookup tables are the router, with one `:id` segment for tenant routes.
// Swap in Fastify when Phase 6 needs route schemas for OpenAPI.
const routes = {
  'GET /healthz': async () => [200, { ok: true }],
  'GET /readyz': async () => {
    if (draining) return [503, { ok: false, reason: 'draining' }];
    try {
      await pool.query('SELECT 1');
      return [200, { ok: true }];
    } catch {
      return [503, { ok: false, reason: 'db unreachable' }];
    }
  },
  'GET /api/hello': async () => {
    const { rows } = await pool.query('SELECT message FROM greetings ORDER BY id LIMIT 1');
    return [200, { message: rows[0]?.message ?? null, replica }];
  },
};

// Constraint violations are the client's fault. The message stays in the log, not the response.
const PG_STATUS = { '23502': 400, '23514': 400, '23503': 409, '23505': 409 };
const pgStatus = (code = '') => PG_STATUS[code] ?? (/^22\w{3}$/.test(code) ? 400 : undefined); // class 22 is bad data

const MAX_BODY = 64 * 1024;
async function readJson(req) {
  let raw = '';
  req.setEncoding('utf8'); // or a multibyte character split across chunks gets mangled
  // Read to the end even when it's too large (without keeping it): an unread body wedges
  // the keep-alive socket, and the next request Caddy sends on it gets a 502.
  for await (const chunk of req) if (raw.length <= MAX_BODY) raw += chunk;
  if (raw.length > MAX_BODY) throw Object.assign(new Error('body too large'), { status: 413 });
  try {
    const body = raw ? JSON.parse(raw) : {};
    if (body && typeof body === 'object' && !Array.isArray(body)) return body;
  } catch {}
  throw Object.assign(new Error('body must be a JSON object'), { status: 400 });
}

// /api/t/:slug/<collection>[/:id] → [metric route, handler call] or undefined.
function matchTenant(method, path) {
  const m = path.match(/^\/api\/t\/([a-z0-9-]+)\/([a-z]+)(?:\/([^/]+))?$/);
  if (!m) return;
  const [, slug, coll, id] = m;
  const key = `${method} /${coll}${id === undefined ? '' : '/:id'}`;
  const handler = tenantRoutes[key];
  if (!handler) return;
  return [`${method} /api/t/:slug/${key.split(' ')[1]}`, (req) => tenantRequest(req, slug, id, handler)];
}

async function tenantRequest(req, slug, id, handler) {
  const userId = verify(SESSION_SECRET, req.headers.authorization);
  if (!userId) return [401, { error: 'unauthorized' }];
  if (id !== undefined && !isUuid(id)) return [404, { error: 'not found' }];
  const body = req.method === 'POST' ? await readJson(req) : undefined;

  const client = await pool.connect();
  let broken;
  // pool.on('error') only covers idle clients. A checked-out client needs its own listener,
  // or a connection dropped mid-transaction crashes the process.
  const onError = (err) => {
    broken = err;
    log('warn', 'db client error', { err: err.message });
  };
  client.on('error', onError);
  try {
    await client.query('BEGIN');
    // First statement of every tenant transaction. Transaction-local (third arg true), so
    // it's safe behind PgBouncer. Not a member (or no such tenant) → '' → RLS shows nothing.
    const { rows } = await client.query(
      "SELECT set_config('app.tenant_id', coalesce(member_tenant_id($1, $2)::text, ''), true) AS tenant_id",
      [slug, userId],
    );
    const result = rows[0].tenant_id ? await handler(client, id, body) : [404, { error: 'not found' }];
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch((e) => (broken = e));
    throw err;
  } finally {
    client.off('error', onError);
    client.release(broken);
  }
}

const server = http.createServer(async (req, res) => {
  const started = process.hrtime.bigint();
  const requestId = req.headers['x-request-id'] || randomUUID();
  const path = req.url.split('?')[0];
  const key = `${req.method} ${path}`;
  res.setHeader('x-replica', replica);
  res.setHeader('x-request-id', requestId);

  if (key === 'GET /metrics') {
    res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' });
    return res.end(render());
  }

  let status;
  let body;
  const [route, handler] = routes[key] ? [key, routes[key]] : (matchTenant(req.method, path) ?? ['unmatched']);
  try {
    [status, body] = handler ? await handler(req) : [404, { error: 'not found' }];
  } catch (err) {
    status = err.status ?? pgStatus(err.code);
    if (status) [status, body] = [status, { error: status === 409 ? 'conflict' : 'invalid request' }];
    else [status, body] = [500, { error: 'internal error', requestId }];
    log(status >= 500 ? 'error' : 'info', err.message, { requestId, path, code: err.code });
  }

  if (body === null) {
    res.writeHead(status);
    res.end();
  } else {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  }

  const seconds = Number(process.hrtime.bigint() - started) / 1e9;
  observe(route, status, seconds); // fixed label set, no cardinality blow-up
  if (!path.endsWith('z')) log('info', 'request', { requestId, method: req.method, path, status, ms: Math.round(seconds * 1000) });
});

function shutdown(signal) {
  if (draining) return;
  draining = true;
  log('info', `${signal} received, draining`);
  server.close(async () => {
    await pool.end();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref(); // below compose stop_grace_period
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

server.listen(PORT, () => log('info', `listening on :${PORT}`));
