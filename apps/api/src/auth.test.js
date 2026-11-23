import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword, sign, unsign, csrfToken, newToken } from './auth.js';
import { can, PERMISSIONS, ROLES } from './permissions.js';

test('argon2id hashes verify only with the right password', async () => {
  const hash = await hashPassword('correct horse');
  assert.match(hash, /^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
  assert.notEqual(hash, await hashPassword('correct horse'), 'salted');
  assert.equal(await verifyPassword(hash, 'correct horse'), true);
  assert.equal(await verifyPassword(hash, 'correct horsf'), false);
  assert.equal(await verifyPassword(null, 'correct horse'), false);
  assert.equal(await verifyPassword('garbage', 'correct horse'), false);
});

test('signed tokens reject tampering and the wrong purpose', () => {
  const token = sign('s', 'invite', ['a', 'b']);
  assert.deepEqual(unsign('s', 'invite', token), ['a', 'b']);
  assert.equal(unsign('s', 'magic', token), null);
  assert.equal(unsign('other', 'invite', token), null);
  assert.equal(unsign('s', 'invite', token.replace('a.b', 'a.c')), null);
  assert.equal(unsign('s', 'invite', 'nodots'), null);
  assert.equal(unsign('s', 'invite', undefined), null);
  assert.notEqual(csrfToken('s', newToken()), csrfToken('s', newToken()));
});

test('can() follows the matrix and denies anything unknown', () => {
  for (const [resource, actions] of Object.entries(PERMISSIONS)) {
    for (const [action, roles] of Object.entries(actions)) {
      for (const role of ROLES) assert.equal(can({ role }, action, resource), roles.includes(role), `${role} ${action} ${resource}`);
    }
  }
  assert.equal(can({ role: 'owner' }, 'read', 'nope'), false);
  assert.equal(can({ role: 'owner' }, 'nope', 'services'), false);
  assert.equal(can({ role: 'owner' }, 'read', 'constructor'), false);
  assert.equal(can({ role: 'owner' }, 'constructor', 'services'), false);
  assert.equal(can({ role: 'root' }, 'read', 'services'), false);
  assert.equal(can(null, 'read', 'services'), false);
});
