// Synthetic GoTrue rejection: only this test's generated credentials are sent.
// No real user account is used or modified, and no passwords are logged.
import { randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';

const endpoint =
  'https://abdxvlykasqmknexxhjo.supabase.co/functions/v1/auth-audit-gateway';
const identity = 'nonexistent-' + randomBytes(12).toString('hex') + '@example.invalid';
const invalidPassword = randomBytes(36).toString('hex');
const checked = await fetch(endpoint, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    action: 'PASSWORD_LOGIN',
    identifier: identity,
    password: invalidPassword,
  }),
  signal: AbortSignal.timeout(20_000),
});
const response = await checked.json();
assert.equal(checked.status, 200, 'Unexpected gateway failure (no credential data printed)');
assert.equal(response.status, 'REJECTED', 'The GoTrue-rejected password must not succeed');
assert.deepEqual(Object.keys(response).sort(), ['status'], 'No tokens or sensitive details on denial');

const unauthenticatedMfa = await fetch(endpoint, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    action: 'MFA_VERIFY',
    factor_id: '00000000-0000-4000-8000-000000000001',
    code: '000000',
  }),
  signal: AbortSignal.timeout(20_000),
});
const mfa = await unauthenticatedMfa.json();
assert.equal(unauthenticatedMfa.status, 401);
assert.equal(mfa.code, 'UNAUTHORIZED');
console.log('PASS: GoTrue invalid password attested, no secret disclosed; unauthenticated MFA denied');
