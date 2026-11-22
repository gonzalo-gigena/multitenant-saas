// The headline test: logged in as one tenant, no endpoint returns or changes another
// tenant's data, even given that tenant's IDs. Needs a seeded stack: `sh infra/test.sh`.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { sign } from '../src/auth.js';
import { tenantRoutes } from '../src/routes.js';

const API = process.env.API_URL ?? 'http://caddy:8080';
const SECRET = process.env.SESSION_SECRET;
const db = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 }); // app_user, like the api

// From infra/db/seed.sql.
const A = { slug: 'demo', id: '00000000-0000-7000-8000-00000000000a', user: '00000000-0000-7000-8000-0000000000a1' };
const B = { slug: 'acme', id: '00000000-0000-7000-8000-00000000000b', user: '00000000-0000-7000-8000-0000000000b1' };

async function call(method, path, { token, body } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: token ? { authorization: `Bearer ${token}` } : {},
    body: body === undefined || typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { status: res.status, text: await res.text() };
}
const as = (who, method, path, body, slug = who.slug) => call(method, `/api/t/${slug}${path}`, { token: who.token, body });

async function create(who, path, body) {
  const res = await as(who, 'POST', path, body);
  assert.equal(res.status, 201, res.text);
  return JSON.parse(res.text).id;
}

before(async () => {
  for (const who of [A, B]) {
    who.token = sign(SECRET, who.user);
    who.marker = `private-${randomUUID()}`;
    const service = await create(who, '/services', { name: who.marker, duration_min: 30, price_cents: 1000 });
    const appointment = await create(who, '/appointments', { service_id: service, customer_name: who.marker, starts_at: '2027-01-01T10:00:00Z' });
    who.ids = { services: service, appointments: appointment };
  }
});
after(() => db.end());

// What an attacker sends to each POST: the victim's IDs in every field that could take one.
// A new POST route fails this suite until it has an entry here.
const attackBody = {
  'POST /services': (victim) => ({ id: victim.ids.services, tenant_id: victim.id, name: 'smuggled', duration_min: 30, price_cents: 1 }),
  'POST /appointments': (victim) => ({ tenant_id: victim.id, service_id: victim.ids.services, customer_name: 'smuggled', starts_at: '2027-01-02T10:00:00Z' }),
};

// Everything the victim can see, to prove an attack changed none of it.
const snapshot = (victim) => Promise.all(Object.keys(victim.ids).map(async (coll) => {
  const res = await as(victim, 'GET', `/${coll}`);
  assert.equal(res.status, 200);
  assert.ok(res.text.includes(victim.ids[coll]), `${victim.slug} lost its ${coll}`);
  return res.text;
}));

function assertNoLeak(res, victim) {
  for (const secret of [victim.id, victim.marker, ...Object.values(victim.ids)]) {
    assert.ok(!res.text.includes(secret), `leaked ${secret}: ${res.text}`);
  }
}

for (const [attacker, victim] of [[B, A], [A, B]]) {
  for (const key of Object.keys(tenantRoutes)) {
    const [method, pattern] = key.split(' ');
    const coll = pattern.split('/')[1];
    const hasId = pattern.endsWith('/:id');

    test(`${attacker.slug} attacking ${victim.slug}: ${key}`, async () => {
      const id = victim.ids[coll];
      assert.ok(id, `no test data for /${coll}: create some in before()`);
      const path = pattern.replace(':id', id);
      let body;
      if (method === 'POST') {
        assert.ok(attackBody[key], `no attack body for ${key}`);
        body = attackBody[key](victim);
      }
      const untouched = await snapshot(victim);

      // In the attacker's own tenant, with the victim's IDs.
      const own = await as(attacker, method, path, body);
      assertNoLeak(own, victim);
      if (hasId) {
        assert.equal(own.status, 404);
        const missing = await as(attacker, method, pattern.replace(':id', randomUUID()), body);
        assert.deepEqual(own, missing, 'a foreign ID must look exactly like a missing one');
      } else if (method === 'GET') {
        assert.equal(own.status, 200);
        assert.ok(own.text.includes(attacker.ids[coll]), 'the list must still show the caller its own rows');
      } else if (key === 'POST /appointments') {
        assert.equal(own.status, 409);
        const missing = await as(attacker, method, path, { ...body, service_id: randomUUID() });
        assert.deepEqual(own, missing, 'a foreign service must look exactly like a missing one');
      } else {
        assert.equal(own.status, 201, 'id and tenant_id in the body are ignored, the row is the caller’s');
      }

      // Directly in the victim's tenant. Must look exactly like a tenant that doesn't exist.
      const theirs = await as(attacker, method, path, body, victim.slug);
      assert.equal(theirs.status, 404);
      assertNoLeak(theirs, victim);
      assert.deepEqual(theirs, await as(attacker, method, path, body, 'no-such-tenant'));

      const anonymous = await call(method, `/api/t/${victim.slug}${path}`, { body });
      assert.equal(anonymous.status, 401);
      assertNoLeak(anonymous, victim);

      assert.deepEqual(await snapshot(victim), untouched, 'the victim’s data changed');
    });
  }
}

test('each tenant can read and delete its own rows', async () => {
  // The control: without it, routes that always answer 404 would pass everything above.
  const service = await create(A, '/services', { name: 'Afeitado ✂', duration_min: 15, price_cents: 0 });
  const appointment = await create(A, '/appointments', { service_id: service, customer_name: 'José', starts_at: '2027-02-01T10:00:00Z' });
  for (const path of [`/appointments/${appointment}`, `/services/${service}`]) {
    assert.equal((await as(A, 'GET', path)).status, 200);
    assert.equal((await as(A, 'DELETE', path)).status, 204);
    assert.equal((await as(A, 'GET', path)).status, 404);
  }
});

test('routes outside /api/t show no tenant data', async () => {
  const res = await call('GET', '/api/hello', { token: B.token });
  assert.equal(res.status, 200);
  assertNoLeak(res, A);
});

test('forged tokens get 401', async () => {
  const [, bobsSignature] = B.token.split('.');
  for (const token of [`${A.user}.${bobsSignature}`, A.user, `${A.user}.`, sign('wrong secret', A.user), 'nonsense']) {
    assert.equal((await call('GET', '/api/t/demo/services', { token })).status, 401, token);
  }
});

test('bad input is the client’s error, never a 500', async () => {
  const good = { name: 'ok', duration_min: 30, price_cents: 1 };
  const cases = [
    [404, 'GET', '/services/not-a-uuid'],
    [400, 'POST', '/services', '{not json'],
    [400, 'POST', '/services', '[]'],
    [400, 'POST', '/services', {}],
    [400, 'POST', '/services', { ...good, name: '' }],
    [400, 'POST', '/services', { ...good, name: 'nul \u0000 byte' }],
    [400, 'POST', '/services', { ...good, price_cents: 2 ** 40 }],
    [400, 'POST', '/appointments', { service_id: 'x', customer_name: 'x', starts_at: '2027-01-01' }],
    [400, 'POST', '/appointments', { service_id: A.ids.services, customer_name: 'x', starts_at: 'infinity' }],
    [413, 'POST', '/services', { ...good, name: 'x'.repeat(200_000) }],
    [409, 'DELETE', `/services/${A.ids.services}`], // still has an appointment
  ];
  for (const [status, method, path, body] of cases) {
    const res = await as(A, method, path, body);
    assert.equal(res.status, status, `${method} ${path} ${JSON.stringify(body)?.slice(0, 80)}: ${res.text}`);
  }
});

test('interleaved tenants on shared pooled connections never mix', async () => {
  await Promise.all(Array.from({ length: 200 }, async (_, i) => {
    const [me, other] = i % 2 ? [A, B] : [B, A];
    const res = await as(me, 'GET', '/services');
    assert.equal(res.status, 200);
    assert.ok(res.text.includes(me.ids.services));
    assertNoLeak(res, other);
  }));
});

test('Postgres enforces isolation for app_user, whatever the app code does', async () => {
  const client = await db.connect(); // one connection throughout, as a pooler would hand out
  try {
    assert.equal((await client.query('SELECT current_user')).rows[0].current_user, 'app_user');
    const count = async () => (await client.query('SELECT count(*)::int AS n FROM services')).rows[0].n;

    assert.equal(await count(), 0, 'no tenant set');

    await client.query('BEGIN');
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [B.id]);
    assert.ok((await count()) > 0);
    // No WHERE tenant_id, on purpose.
    assert.deepEqual((await client.query('SELECT DISTINCT tenant_id FROM services')).rows, [{ tenant_id: B.id }]);
    assert.equal((await client.query('DELETE FROM appointments WHERE id = $1', [A.ids.appointments])).rowCount, 0);
    await client.query('SAVEPOINT forge');
    await assert.rejects(
      client.query("INSERT INTO services (tenant_id, name, duration_min, price_cents) VALUES ($1, 'forged', 1, 1)", [A.id]),
      { code: '42501' },
    );
    await client.query('ROLLBACK TO SAVEPOINT forge');
    await client.query('COMMIT');

    assert.equal(await count(), 0, 'the tenant must not outlive its transaction');
    for (const table of ['tenants', 'users', 'memberships']) {
      await assert.rejects(client.query(`SELECT * FROM ${table}`), { code: '42501' }, table);
    }
  } finally {
    client.release(true);
  }
});
