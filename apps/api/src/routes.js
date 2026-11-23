// Tenant routes, served under /api/t/:slug. Each one is [action, resource, handler]:
// server.js checks can(member, action, resource) before the handler runs, and answers 403
// if not. Handlers get a client already inside a transaction with app.tenant_id set, so
// RLS does the filtering: handlers never write `WHERE tenant_id = …` and inserts never
// pass tenant_id (the column defaults to it).
// Background jobs (pg-boss, later) skip this path: each job carries tenant_id in its
// payload and must start its own transaction with the same set_config call.
// Column checks live in the database; server.js maps constraint errors to 400/409.

const one = (rows) => (rows[0] ? [200, rows[0]] : [404, { error: 'not found' }]);
const gone = (rowCount) => (rowCount ? [204, null] : [404, { error: 'not found' }]);
const list = async (db, sql) => [200, (await db.query(sql)).rows];

const SERVICE = 'id, name, duration_min, price_cents, created_at';
const APPOINTMENT = 'id, service_id, customer_name, starts_at, created_at';
const INVITE = 'id, email, role, expires_at, created_at';

export const tenantRoutes = {
  'GET /services': ['read', 'services', (db) => list(db, `SELECT ${SERVICE} FROM services ORDER BY name`)],
  'POST /services': ['write', 'services', async (db, { body: b }) => [201, (await db.query(
    `INSERT INTO services (name, duration_min, price_cents) VALUES ($1, $2, $3) RETURNING ${SERVICE}`,
    [b.name, b.duration_min, b.price_cents])).rows[0]]],
  'GET /services/:id': ['read', 'services', async (db, { id }) => one((await db.query(`SELECT ${SERVICE} FROM services WHERE id = $1`, [id])).rows)],
  'DELETE /services/:id': ['write', 'services', async (db, { id }) => gone((await db.query('DELETE FROM services WHERE id = $1', [id])).rowCount)],

  'GET /appointments': ['read', 'appointments', (db) => list(db, `SELECT ${APPOINTMENT} FROM appointments ORDER BY starts_at`)],
  'POST /appointments': ['write', 'appointments', async (db, { body: b }) => [201, (await db.query(
    `INSERT INTO appointments (service_id, customer_name, starts_at) VALUES ($1, $2, $3) RETURNING ${APPOINTMENT}`,
    [b.service_id, b.customer_name, b.starts_at])).rows[0]]],
  'GET /appointments/:id': ['read', 'appointments', async (db, { id }) => one((await db.query(`SELECT ${APPOINTMENT} FROM appointments WHERE id = $1`, [id])).rows)],
  'DELETE /appointments/:id': ['write', 'appointments', async (db, { id }) => gone((await db.query('DELETE FROM appointments WHERE id = $1', [id])).rowCount)],

  // Members are keyed by user id. Owners can't be demoted or removed, so a tenant always
  // keeps one. ponytail: ownership transfer and "leave tenant" come when someone asks.
  'GET /members': ['read', 'members', (db) => list(db, 'SELECT id, email, role, created_at FROM tenant_members()')],
  'PATCH /members/:id': ['manage', 'members', async (db, { id, body }) => one((await db.query(
    "UPDATE memberships SET role = $2 WHERE user_id = $1 AND role <> 'owner' RETURNING user_id AS id, role",
    [id, body.role])).rows)],
  'DELETE /members/:id': ['manage', 'members', async (db, { id }) => gone((await db.query(
    "DELETE FROM memberships WHERE user_id = $1 AND role <> 'owner'", [id])).rowCount)],

  'GET /invites': ['read', 'invites', (db) => list(db, `SELECT ${INVITE} FROM invites ORDER BY created_at`)],
  // The link goes only to the invitee's inbox, never into the response.
  'POST /invites': ['write', 'invites', async (db, { body: b, user, sendInvite }) => {
    const { rows } = await db.query(
      `INSERT INTO invites (email, role, invited_by) VALUES (lower($1), $2, $3) RETURNING ${INVITE}, tenant_id`,
      [b.email, b.role, user.id]);
    const { tenant_id, ...invite } = rows[0];
    await sendInvite(tenant_id, invite);
    return [201, invite];
  }],
  'DELETE /invites/:id': ['write', 'invites', async (db, { id }) => gone((await db.query('DELETE FROM invites WHERE id = $1', [id])).rowCount)],
};
