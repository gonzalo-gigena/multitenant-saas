import http from 'node:http';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { observe, render } from './metrics.js';
import {
  csrfToken, hashPassword, isEmail, isPassword, isUuid, newToken, safeEqual, sign, tokenHash, unsign, verifyPassword,
} from './auth.js';
import { sendMail } from './mail.js';
import { can } from './permissions.js';
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
const SECRET = env('SESSION_SECRET');
// Links in emails are built from this, never from the Host header, which the client controls.
const APP_URL = env('APP_URL', 'http://localhost:8080').replace(/\/$/, '');
const SMTP_URL = env('SMTP_URL', 'smtp://mailpit:1025');
const MAIL_FROM = env('MAIL_FROM', 'no-reply@example.test');

const SESSION_DAYS = 14; // ponytail: absolute expiry, no sliding refresh
const MAGIC_MINUTES = 15;
// Secure whenever the app is served over https. Browsers treat http://localhost as secure
// too, but Safari doesn't, so local dev leaves it off.
const COOKIE = `Path=/; HttpOnly; SameSite=Lax${APP_URL.startsWith('https:') ? '; Secure' : ''}`;

const log = (level, msg, extra = {}) =>
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, msg, replica, ...extra }));

// A dropped idle connection emits 'error' on the pool. Unhandled, it crashes the process.
pool.on('error', (err) => log('warn', 'idle db client error', { err: err.message }));

let draining = false;

const fail = (status, error) => Object.assign(new Error(error), { status, public: error });
const MUTATING = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

function getCookie(req, name) {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [k, v] = part.trim().split('=');
    if (k === name) return v;
  }
}

// The signed-in user, or null. Mutations also need the session's CSRF token in
// `x-csrf-token`: SameSite=Lax already keeps the cookie off cross-site POSTs, and the
// token covers older browsers and same-site subdomains (every tenant's booking page).
async function currentUser(req) {
  const token = getCookie(req, 'sid');
  if (!token) return null;
  const hash = tokenHash(token);
  const { rows } = await pool.query('SELECT user_id, email FROM auth_session($1)', [hash]);
  if (!rows[0]) return null;
  if (MUTATING.has(req.method) && !safeEqual(req.headers['x-csrf-token'], csrfToken(SECRET, token))) {
    throw fail(403, 'missing or wrong x-csrf-token');
  }
  return { id: rows[0].user_id, email: rows[0].email, hash };
}

async function requireUser(req) {
  const user = await currentUser(req);
  if (!user) throw fail(401, 'unauthorized');
  return user;
}

async function startSession(userId, status, body = {}, headers = {}) {
  const token = newToken();
  await pool.query(
    `INSERT INTO sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '${SESSION_DAYS} days')`,
    [tokenHash(token), userId],
  );
  return [status, { ...body, csrf: csrfToken(SECRET, token) }, {
    ...headers, 'set-cookie': `sid=${token}; Max-Age=${SESSION_DAYS * 86400}; ${COOKIE}`,
  }];
}

// One transaction on one client: BEGIN, fn, COMMIT (or ROLLBACK).
async function inTransaction(fn) {
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
    const result = await fn(client);
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

const credentials = (body) => {
  if (!isEmail(body.email) || !isPassword(body.password)) throw fail(400, 'email and a password of 8 to 256 characters');
  return [body.email.toLowerCase(), body.password];
};

const sendInvite = (tenantId, invite) => sendMail(SMTP_URL, {
  from: MAIL_FROM, to: invite.email, subject: `You're invited as ${invite.role}`,
  text: `Accept within 7 days: ${APP_URL}/?invite=${sign(SECRET, 'invite', [tenantId, invite.id])}\n`,
});

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

  // ponytail: no login rate limit yet. argon2id makes guessing slow; Redis limits come in Phase 6.
  'POST /api/auth/signup': async (req) => {
    const [email, password] = credentials(await readJson(req));
    const { rows } = await pool.query('SELECT create_user($1, $2) AS id', [email, await hashPassword(password)]);
    return startSession(rows[0].id, 201, { id: rows[0].id, email });
  },
  'POST /api/auth/login': async (req) => {
    const [email, password] = credentials(await readJson(req));
    const { rows } = await pool.query('SELECT id, password_hash FROM login_lookup($1)', [email]);
    if (!(await verifyPassword(rows[0]?.password_hash, password))) throw fail(401, 'wrong email or password');
    return startSession(rows[0].id, 200, { id: rows[0].id, email });
  },
  'POST /api/auth/logout': async (req) => {
    const user = await requireUser(req);
    await pool.query('SELECT end_session($1)', [user.hash]);
    return [204, null, { 'set-cookie': `sid=; Max-Age=0; ${COOKIE}` }];
  },
  // Always 202, whether or not the email has an account. The first click creates it.
  // ponytail: a link works until it expires, not once. Mail scanners prefetch links, and
  // anyone who can read the inbox can request a fresh one anyway.
  'POST /api/auth/magic': async (req) => {
    const { email } = await readJson(req);
    if (!isEmail(email)) throw fail(400, 'email');
    const exp = Math.floor(Date.now() / 1000) + MAGIC_MINUTES * 60;
    const token = sign(SECRET, 'magic', [Buffer.from(email.toLowerCase()).toString('base64url'), exp]);
    await sendMail(SMTP_URL, {
      from: MAIL_FROM, to: email, subject: 'Your sign-in link',
      text: `Sign in within ${MAGIC_MINUTES} minutes: ${APP_URL}/api/auth/magic?token=${token}\n`,
    });
    return [202, { ok: true }];
  },
  'GET /api/auth/magic': async (req) => {
    const parts = unsign(SECRET, 'magic', new URL(req.url, APP_URL).searchParams.get('token'));
    const [email, exp] = parts ?? [];
    if (!parts || !(Number(exp) * 1000 > Date.now())) return [303, null, { location: '/?error=expired-link' }];
    const { rows } = await pool.query('SELECT ensure_user($1) AS id', [Buffer.from(email, 'base64url').toString()]);
    const [, , headers] = await startSession(rows[0].id, 303);
    return [303, null, { ...headers, location: '/' }];
  },

  // Who am I, which tenants can I switch to, and the CSRF token for this session.
  'GET /api/me': async (req) => {
    const user = await requireUser(req);
    const { rows } = await pool.query('SELECT slug, name, role FROM user_tenants($1)', [user.id]);
    return [200, { id: user.id, email: user.email, tenants: rows, csrf: csrfToken(SECRET, getCookie(req, 'sid')) }];
  },
  'POST /api/tenants': async (req) => {
    const user = await requireUser(req);
    const { slug, name } = await readJson(req);
    if (typeof name !== 'string' || !name.trim() || name.length > 200) throw fail(400, 'name');
    await pool.query('SELECT create_tenant($1, $2, $3)', [slug, name.trim(), user.id]);
    return [201, { slug, name: name.trim(), role: 'owner' }];
  },
  // The token proves the tenant and invite ID. The row proves it's unexpired and unused, and
  // its email has to be the signed-in user's: a forwarded link is no use to anyone else.
  'POST /api/invites/accept': async (req) => {
    const user = await requireUser(req);
    const [tenantId, inviteId] = unsign(SECRET, 'invite', (await readJson(req)).token) ?? [];
    if (!isUuid(tenantId ?? '') || !isUuid(inviteId ?? '')) throw fail(404, 'not found');
    return inTransaction(async (db) => {
      await db.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
      const { rows } = await db.query(
        'DELETE FROM invites WHERE id = $1 AND email = $2 AND expires_at > now() RETURNING role', [inviteId, user.email]);
      if (!rows[0]) return [404, { error: 'invite not found, expired, or for another email' }];
      await db.query('INSERT INTO memberships (user_id, role) VALUES ($1, $2) ON CONFLICT DO NOTHING', [user.id, rows[0].role]);
      const tenants = await db.query('SELECT slug, name, role FROM user_tenants($1) WHERE id = $2', [user.id, tenantId]);
      return [200, tenants.rows[0]];
    });
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
  if (!Object.hasOwn(tenantRoutes, key)) return;
  return [`${method} /api/t/:slug/${key.split(' ')[1]}`, (req) => tenantRequest(req, slug, id, tenantRoutes[key])];
}

async function tenantRequest(req, slug, id, [action, resource, handler]) {
  const user = await requireUser(req);
  if (id !== undefined && !isUuid(id)) return [404, { error: 'not found' }];
  const body = req.method === 'POST' || req.method === 'PATCH' ? await readJson(req) : undefined;

  return inTransaction(async (db) => {
    // First statement of every tenant transaction. Transaction-local (third arg true), so
    // it's safe behind PgBouncer. Not a member (or no such tenant) → '' → RLS shows nothing.
    const { rows } = await db.query(
      "SELECT set_config('app.tenant_id', coalesce(member_tenant_id($1, $2)::text, ''), true) AS tenant_id",
      [slug, user.id],
    );
    if (!rows[0].tenant_id) return [404, { error: 'not found' }];
    // Under RLS, so this can only be the membership in this tenant.
    const member = (await db.query('SELECT role FROM memberships WHERE user_id = $1', [user.id])).rows[0];
    if (!can(member, action, resource)) return [403, { error: `${member.role} can't ${action} ${resource}` }];
    return handler(db, { id, body, user, sendInvite });
  });
}

// A cross-site form or fetch carries an Origin that isn't ours. Covers sign-in and sign-up,
// which have no session (and so no CSRF token) yet.
function crossSite(req) {
  if (!MUTATING.has(req.method) || !req.headers.origin) return false;
  try {
    return new URL(req.headers.origin).host !== req.headers.host;
  } catch {
    return true;
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
  let headers = {};
  const [route, handler] = Object.hasOwn(routes, key) ? [key, routes[key]] : (matchTenant(req.method, path) ?? ['unmatched']);
  try {
    if (crossSite(req)) throw fail(403, 'cross-site request');
    [status, body, headers = {}] = handler ? await handler(req) : [404, { error: 'not found' }];
  } catch (err) {
    status = err.status ?? pgStatus(err.code);
    if (status) body = { error: err.public ?? (status === 409 ? 'conflict' : 'invalid request') };
    else [status, body] = [500, { error: 'internal error', requestId }];
    log(status >= 500 ? 'error' : 'info', err.message, { requestId, path, code: err.code });
  }

  res.setHeader('cache-control', 'no-store');
  if (body === null) {
    res.writeHead(status, headers);
    res.end();
  } else {
    res.writeHead(status, { ...headers, 'content-type': 'application/json' });
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
