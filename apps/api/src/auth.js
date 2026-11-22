import { createHmac, timingSafeEqual } from 'node:crypto';

// ponytail: a signed bearer token `<userId>.<hmac>` stands in for login until Phase 2
// (argon2id + HTTP-only session cookie). No expiry or revocation: don't ship it.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const mac = (secret, userId) => createHmac('sha256', secret).update(userId).digest('base64url');

export const sign = (secret, userId) => `${userId}.${mac(secret, userId)}`;

export function verify(secret, header = '') {
  const [userId, sig = ''] = header.replace(/^Bearer /, '').split('.');
  if (!UUID.test(userId)) return null;
  const want = Buffer.from(mac(secret, userId));
  const got = Buffer.from(sig);
  return got.length === want.length && timingSafeEqual(got, want) ? userId : null;
}

export const isUuid = (s) => UUID.test(s);
