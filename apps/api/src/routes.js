// Tenant routes, served under /api/t/:slug. Each handler gets a client already inside a
// transaction with app.tenant_id set, so RLS does the filtering: handlers never write
// `WHERE tenant_id = …` and inserts never pass tenant_id (the column defaults to it).
// Background jobs (pg-boss, later) skip this path: each job carries tenant_id in its
// payload and must start its own transaction with the same set_config call.
// Column checks live in the database; server.js maps constraint errors to 400/409.

const one = (rows) => (rows[0] ? [200, rows[0]] : [404, { error: 'not found' }]);
const gone = (rowCount) => (rowCount ? [204, null] : [404, { error: 'not found' }]);

const SERVICE = 'id, name, duration_min, price_cents, created_at';
const APPOINTMENT = 'id, service_id, customer_name, starts_at, created_at';

export const tenantRoutes = {
  'GET /services': async (db) => [200, (await db.query(`SELECT ${SERVICE} FROM services ORDER BY name`)).rows],
  'POST /services': async (db, _, b) => [201, (await db.query(
    `INSERT INTO services (name, duration_min, price_cents) VALUES ($1, $2, $3) RETURNING ${SERVICE}`,
    [b.name, b.duration_min, b.price_cents])).rows[0]],
  'GET /services/:id': async (db, id) => one((await db.query(`SELECT ${SERVICE} FROM services WHERE id = $1`, [id])).rows),
  'DELETE /services/:id': async (db, id) => gone((await db.query('DELETE FROM services WHERE id = $1', [id])).rowCount),

  'GET /appointments': async (db) => [200, (await db.query(`SELECT ${APPOINTMENT} FROM appointments ORDER BY starts_at`)).rows],
  'POST /appointments': async (db, _, b) => [201, (await db.query(
    `INSERT INTO appointments (service_id, customer_name, starts_at) VALUES ($1, $2, $3) RETURNING ${APPOINTMENT}`,
    [b.service_id, b.customer_name, b.starts_at])).rows[0]],
  'GET /appointments/:id': async (db, id) => one((await db.query(`SELECT ${APPOINTMENT} FROM appointments WHERE id = $1`, [id])).rows),
  'DELETE /appointments/:id': async (db, id) => gone((await db.query('DELETE FROM appointments WHERE id = $1', [id])).rowCount),
};
