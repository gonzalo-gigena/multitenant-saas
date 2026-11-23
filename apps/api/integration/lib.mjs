// Shared by the integration suites (.mjs, so `node --test 'integration/*.js'` doesn't run it).
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

export const API = process.env.API_URL ?? 'http://caddy:8080';
const MAILPIT = process.env.MAILPIT_URL ?? 'http://mailpit:8025';

// who: { sid, csrf } from signIn(), or nothing for an anonymous call.
export async function call(method, path, { who, body, headers = {} } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    redirect: 'manual',
    headers: { ...(who ? { cookie: `sid=${who.sid}`, 'x-csrf-token': who.csrf } : {}), ...headers },
    body: body === undefined || typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { status: res.status, text: await res.text(), headers: res.headers };
}

export const sid = (res) => res.headers.getSetCookie().join(';').match(/sid=([^;]*)/)?.[1];

export async function signIn(email, password = 'demo-password', path = '/api/auth/login') {
  const res = await call('POST', path, { body: { email, password } });
  assert.ok(res.status === 200 || res.status === 201, res.text);
  const { id, csrf } = JSON.parse(res.text);
  return { id, email, csrf, sid: sid(res) };
}

export const signUp = (email = `${randomUUID()}@test.test`) => signIn(email, 'a long enough password', '/api/auth/signup');

// The plain-text body of the newest email to `to`, from Mailpit.
export async function inbox(to) {
  for (let i = 0; i < 50; i++) {
    const found = await (await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}`)).json();
    if (found.messages?.length) return (await (await fetch(`${MAILPIT}/api/v1/message/${found.messages[0].ID}`)).json()).Text;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`no email to ${to}`);
}

// Invite `email` to `slug` as `role` (as `by`), and return the token from the email.
export async function inviteToken(by, slug, email, role) {
  const res = await call('POST', `/api/t/${slug}/invites`, { who: by, body: { email, role } });
  assert.equal(res.status, 201, res.text);
  return (await inbox(email)).match(/invite=([\w.-]+)/)[1];
}

// A new user who is a member of `slug` with `role`, through the real invite flow.
export async function newMember(owner, slug, role) {
  const user = await signUp();
  const token = await inviteToken(owner, slug, user.email, role);
  const res = await call('POST', '/api/invites/accept', { who: user, body: { token } });
  assert.equal(res.status, 200, res.text);
  return user;
}
