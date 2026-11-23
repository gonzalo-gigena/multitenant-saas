// Phase 2's "done when": every cell of the README's role-permission matrix is backed by a
// test. For each tenant route × role, a fresh target is made as the owner, then the route
// is called as that role: allowed cells must succeed, denied ones must get 403 and change
// nothing. Needs a seeded stack with Mailpit: `sh infra/test.sh`.
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { tenantRoutes } from '../src/routes.js';
import { can, PERMISSIONS, ROLES } from '../src/permissions.js';
import { call, inbox, inviteToken, newMember, sid, signIn, signUp } from './lib.mjs';

const slug = `roles-${randomUUID().slice(0, 8)}`;
const users = {};
const as = (who, method, path, body) => call(method, `/api/t/${slug}${path}`, { who, body });

async function make(path, body) {
  const res = await as(users.owner, 'POST', path, body);
  assert.equal(res.status, 201, res.text);
  return JSON.parse(res.text).id;
}
const service = () => make('/services', { name: `s-${randomUUID()}`, duration_min: 30, price_cents: 100 });
const appointment = async () => make('/appointments', { service_id: await service(), customer_name: 'x', starts_at: '2027-03-01T10:00:00Z' });
const invite = () => make('/invites', { email: `${randomUUID()}@invitee.test`, role: 'staff' });

// Which matrix cell each route belongs to (so a DELETE can't be mislabeled `read`), and what
// it's called with: a fresh target, so an allowed call can succeed (and a DELETE doesn't eat
// a row the next role needs). A new route fails until it's listed here.
const requests = {
  'GET /services': ['read services', async () => ['/services']],
  'POST /services': ['write services', async () => ['/services', { name: `n-${randomUUID()}`, duration_min: 15, price_cents: 0 }]],
  'GET /services/:id': ['read services', async () => [`/services/${await service()}`]],
  'DELETE /services/:id': ['write services', async () => [`/services/${await service()}`]],
  'GET /appointments': ['read appointments', async () => ['/appointments']],
  'POST /appointments': ['write appointments', async () => ['/appointments', { service_id: await service(), customer_name: 'y', starts_at: '2027-03-02T10:00:00Z' }]],
  'GET /appointments/:id': ['read appointments', async () => [`/appointments/${await appointment()}`]],
  'DELETE /appointments/:id': ['write appointments', async () => [`/appointments/${await appointment()}`]],
  'GET /members': ['read members', async () => ['/members']],
  'PATCH /members/:id': ['manage members', async () => [`/members/${(await newMember(users.owner, slug, 'staff')).id}`, { role: 'admin' }]],
  'DELETE /members/:id': ['manage members', async () => [`/members/${(await newMember(users.owner, slug, 'staff')).id}`]],
  'GET /invites': ['read invites', async () => ['/invites']],
  'POST /invites': ['write invites', async () => ['/invites', { email: `${randomUUID()}@invitee.test`, role: 'staff' }]],
  'DELETE /invites/:id': ['write invites', async () => [`/invites/${await invite()}`]],
};

before(async () => {
  users.owner = await signUp();
  const res = await call('POST', '/api/tenants', { who: users.owner, body: { slug, name: 'Roles Test' } });
  assert.equal(res.status, 201, res.text);
  users.admin = await newMember(users.owner, slug, 'admin');
  users.staff = await newMember(users.owner, slug, 'staff');
});

test('the README matrix is exactly PERMISSIONS', () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  const rows = [...readme.matchAll(/^\| `(\w+)` \| `(\w+)` \|(.+)\|\s*$/gm)];
  const fromReadme = {};
  for (const [, resource, action, cells] of rows) {
    const marks = cells.split('|').map((c) => c.trim());
    assert.equal(marks.length, ROLES.length, `README row ${resource} ${action}`);
    (fromReadme[resource] ??= {})[action] = ROLES.filter((_, i) => marks[i] === '✅');
    assert.ok(marks.every((m) => m === '✅' || m === '—'), `README row ${resource} ${action}: use ✅ or —`);
  }
  assert.deepEqual(fromReadme, PERMISSIONS);
});

test('every cell of the matrix is guarded by at least one route', () => {
  const used = new Set(Object.values(tenantRoutes).map(([action, resource]) => `${action} ${resource}`));
  for (const [resource, actions] of Object.entries(PERMISSIONS)) {
    for (const action of Object.keys(actions)) assert.ok(used.has(`${action} ${resource}`), `no route checks ${action} ${resource}`);
  }
  for (const [key, [action, resource]] of Object.entries(tenantRoutes)) {
    assert.ok(Object.hasOwn(PERMISSIONS[resource] ?? {}, action), `${key} checks ${action} ${resource}, which isn't in the matrix`);
  }
});

for (const [key, [action, resource]] of Object.entries(tenantRoutes)) {
  const [method] = key.split(' ');
  for (const role of ROLES) {
    const allowed = can({ role }, action, resource);
    test(`${role} ${allowed ? 'can' : "can't"} ${action} ${resource}: ${key}`, async () => {
      assert.ok(requests[key], `no request for ${key}`);
      assert.equal(`${action} ${resource}`, requests[key][0], `${key} checks the wrong permission`);
      const [path, body] = await requests[key][1]();
      const list = () => as(users.owner, 'GET', `/${resource}`); // each resource has a list route
      const before = method === 'GET' ? null : await list();
      const res = await as(users[role], method, path, body);
      if (allowed) {
        assert.ok(res.status >= 200 && res.status < 300, `${res.status} ${res.text}`);
      } else {
        assert.equal(res.status, 403, res.text);
        assert.deepEqual(JSON.parse(res.text), { error: `${role} can't ${action} ${resource}` });
        if (before) {
          assert.equal((await list()).text, before.text, 'a denied call changed data');
        }
      }
    });
  }
}

test('owners can be neither demoted nor removed, so a tenant always has one', async () => {
  for (const [method, body] of [['PATCH', { role: 'staff' }], ['DELETE']]) {
    assert.equal((await as(users.owner, method, `/members/${users.owner.id}`, body)).status, 404);
  }
  assert.equal((await as(users.owner, 'POST', '/invites', { email: 'x@y.test', role: 'owner' })).status, 400, 'owners are never made by link');
});

test('invites: one use, only for the invited email, tamper-proof', async () => {
  const invitee = await signUp();
  const token = await inviteToken(users.owner, slug, invitee.email, 'staff');
  const accept = (who, t = token) => call('POST', '/api/invites/accept', { who, body: { token: t } });

  assert.equal((await accept(undefined)).status, 401);
  assert.equal((await accept(await signUp())).status, 404, 'someone else holding the link');
  const [tenant, id] = token.split('.');
  assert.equal((await accept(invitee, `${tenant}.${randomUUID()}.${token.split('.')[2]}`)).status, 404, 'tampered');
  const ok = await accept(invitee);
  assert.equal(ok.status, 200, ok.text);
  assert.equal(JSON.parse(ok.text).slug, slug);
  assert.equal(JSON.parse(ok.text).role, 'staff');
  assert.equal((await accept(invitee)).status, 404, 'second use');
  assert.ok(!(await as(users.owner, 'GET', '/invites')).text.includes(id));

  // Revoked before use.
  const later = await signUp();
  const revoked = await inviteToken(users.owner, slug, later.email, 'admin');
  assert.equal((await as(users.owner, 'DELETE', `/invites/${revoked.split('.')[1]}`)).status, 204);
  assert.equal((await accept(later, revoked)).status, 404);

  // A removed member can't rejoin by replaying the link they joined with.
  assert.equal((await as(users.owner, 'DELETE', `/members/${invitee.id}`)).status, 204);
  assert.equal((await accept(invitee)).status, 404);
  assert.equal((await as(invitee, 'GET', '/services')).status, 404, 'ex-members look like strangers');
});

test('the tenant switcher lists every tenant the user belongs to, with its role', async () => {
  const other = `roles2-${randomUUID().slice(0, 8)}`;
  assert.equal((await call('POST', '/api/tenants', { who: users.staff, body: { slug: other, name: 'Second' } })).status, 201);
  const me = JSON.parse((await call('GET', '/api/me', { who: users.staff })).text);
  assert.deepEqual(me.tenants.map((t) => [t.slug, t.role]).sort(), [[slug, 'staff'], [other, 'owner']].sort());
  assert.equal((await call('POST', '/api/tenants', { who: users.staff, body: { slug: other, name: 'Taken' } })).status, 409);
});

test('passwords: argon2id, wrong ones and unknown emails look the same', async () => {
  const user = await signUp();
  assert.equal((await call('POST', '/api/auth/signup', { body: { email: user.email, password: 'another password' } })).status, 409);
  const wrong = await call('POST', '/api/auth/login', { body: { email: user.email, password: 'not the password' } });
  const unknown = await call('POST', '/api/auth/login', { body: { email: `${randomUUID()}@nobody.test`, password: 'not the password' } });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.text, unknown.text);
  assert.equal((await call('POST', '/api/auth/signup', { body: { email: 'short@pw.test', password: '1234567' } })).status, 400);
  assert.equal((await signIn(user.email, 'a long enough password')).email, user.email);
});

test('session cookie is HttpOnly and SameSite=Lax', async () => {
  const res = await call('POST', '/api/auth/login', { body: { email: 'alice@demo.test', password: 'demo-password' } });
  const cookie = res.headers.getSetCookie().find((c) => c.startsWith('sid='));
  assert.match(cookie, /; HttpOnly/);
  assert.match(cookie, /; SameSite=Lax/);
  assert.match(cookie, /; Path=\//);
});

test('CSRF: mutations need the session token and a same-origin Origin', async () => {
  const body = { name: 'csrf', duration_min: 10, price_cents: 0 };
  const owner = users.owner;
  for (const csrf of [undefined, '', 'wrong', users.admin.csrf]) {
    const res = await call('POST', `/api/t/${slug}/services`, { who: { sid: owner.sid, csrf }, body });
    assert.equal(res.status, 403, `csrf=${csrf}`);
  }
  const evil = await call('POST', `/api/t/${slug}/services`, { who: owner, body, headers: { origin: 'https://evil.test' } });
  assert.equal(evil.status, 403);
  const login = await call('POST', '/api/auth/login', { body: { email: 'alice@demo.test', password: 'demo-password' }, headers: { origin: 'https://evil.test' } });
  assert.equal(login.status, 403, 'login CSRF');
  // GETs don't need the token.
  assert.equal((await call('GET', `/api/t/${slug}/services`, { who: { sid: owner.sid } })).status, 200);
});

test('magic link: emailed, signs in (creating the account), and expires', async () => {
  const email = `${randomUUID()}@magic.test`;
  assert.equal((await call('POST', '/api/auth/magic', { body: { email } })).status, 202);
  const link = (await inbox(email)).match(/(\/api\/auth\/magic\?token=[\w.-]+)/)[1];
  assert.match(await inbox(email), /http:\/\/localhost:8080\/api\/auth\/magic/, 'links come from APP_URL, not Host');

  const res = await call('GET', link);
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), '/');
  const me = await call('GET', '/api/me', { who: { sid: sid(res) } });
  assert.equal(JSON.parse(me.text).email, email);

  const token = link.split('=')[1];
  const [address, , mac] = token.split('.');
  const bad = await call('GET', `/api/auth/magic?token=${address}.${Math.floor(Date.now() / 1000) + 3600}.${mac}`);
  assert.equal(bad.headers.get('location'), '/?error=expired-link', 'extending the expiry breaks the signature');
  assert.equal(sid(bad), undefined);
});
