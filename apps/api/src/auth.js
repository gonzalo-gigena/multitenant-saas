import { argon2, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const argon = promisify(argon2);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isUuid = (s) => UUID.test(s);
// No whitespace or angle brackets, so an address can't inject SMTP commands or headers.
export const isEmail = (s) => typeof s === 'string' && s.length <= 254 && /^[^\s@<>]+@[^\s@<>]+$/.test(s);
export const isPassword = (s) => typeof s === 'string' && s.length >= 8 && s.length <= 256;

// argon2id at OWASP's minimum: 19 MiB, 2 passes, 1 lane. Stored in PHC format, so the cost
// can go up later and old hashes still verify with their own parameters.
const COST = { memory: 19456, passes: 2, parallelism: 1 };
const PHC = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([^$]+)\$([^$]+)$/;
const b64 = (buf) => buf.toString('base64').replace(/=+$/, '');

export async function hashPassword(password) {
  const nonce = randomBytes(16);
  const hash = await argon('argon2id', { message: password, nonce, tagLength: 32, ...COST });
  return `$argon2id$v=19$m=${COST.memory},t=${COST.passes},p=${COST.parallelism}$${b64(nonce)}$${b64(hash)}`;
}

// Unknown emails (and users without a password) are checked against this, so a miss
// takes as long as a wrong password and doesn't reveal which emails have accounts.
const dummy = hashPassword(randomBytes(16).toString('hex'));

export async function verifyPassword(stored, password) {
  const real = PHC.exec(stored ?? '');
  const [, m, t, p, salt, hash] = real ?? PHC.exec(await dummy);
  const want = Buffer.from(hash, 'base64');
  const got = await argon('argon2id', {
    message: password, nonce: Buffer.from(salt, 'base64'), tagLength: want.length,
    memory: Number(m), passes: Number(t), parallelism: Number(p),
  });
  return timingSafeEqual(got, want) && Boolean(real);
}

// Sessions: the cookie holds 32 random bytes, the database only their SHA-256.
export const newToken = () => randomBytes(32).toString('base64url');
export const tokenHash = (token) => createHash('sha256').update(token).digest();

const mac = (secret, purpose, payload) => createHmac('sha256', secret).update(`${purpose}:${payload}`).digest('base64url');
export const safeEqual = (a, b) => typeof a === 'string' && typeof b === 'string' &&
  a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

// CSRF token, derived from the session, so there's nothing extra to store. Sent back in
// `x-csrf-token` on every mutation. A cross-site page can't read it or set that header.
export const csrfToken = (secret, sessionToken) => mac(secret, 'csrf', sessionToken);

// `part.part.mac`, for links in emails. The purpose is part of the MAC, so an invite token
// can't be replayed as a magic link. Parts must not contain dots.
export const sign = (secret, purpose, parts) => `${parts.join('.')}.${mac(secret, purpose, parts.join('.'))}`;
export function unsign(secret, purpose, token) {
  if (typeof token !== 'string') return null;
  const i = token.lastIndexOf('.');
  const payload = token.slice(0, i);
  return i > 0 && safeEqual(token.slice(i + 1), mac(secret, purpose, payload)) ? payload.split('.') : null;
}
