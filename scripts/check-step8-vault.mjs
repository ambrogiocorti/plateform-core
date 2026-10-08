import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { openDB } from 'idb';
import { z } from 'zod';
import { clearOffline, vaultGet, vaultPut } from '../src/offline/vault.ts';
import { authorizationSchema, verifyOfflineAuthorization } from '../src/offline/authorization.ts';

await vaultPut('probe', { value: 42 });
assert.deepEqual(
  await vaultGet('probe', z.object({ value: z.number() })),
  { value: 42 },
  'AES-GCM vault roundtrip',
);
await vaultPut('queue', []);
await vaultPut('context', { secret: 'context' });
await clearOffline();
assert.equal(await vaultGet('context', z.unknown()), undefined, 'logout clears offline context');
assert.deepEqual(await vaultGet('queue', z.array(z.unknown())), [], 'logout preserves queue');

const db = await openDB('plateform-staff-offline', 1);
const stored = await db.get('vault', 'queue');
assert.ok(stored?.ciphertext instanceof ArrayBuffer, 'queue is stored as ciphertext');
const corrupted = stored.ciphertext.slice(0);
new Uint8Array(corrupted)[0] ^= 0xff;
await db.put('vault', { ...stored, ciphertext: corrupted }, 'queue');
await assert.rejects(
  () => vaultGet('queue', z.array(z.unknown())),
  /OFFLINE_QUEUE_UNREADABLE/,
  'tampered queue fails closed',
);
db.close();

const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
  'sign',
  'verify',
]);
const publicKey = await crypto.subtle.exportKey('jwk', keys.publicKey);
const now = Date.now();
const payload = JSON.stringify({
  user_id: '30000000-0000-4000-8000-000000000001',
  role: 'WAITER',
  scope: 'VENUE',
  device_id: '30000000-0000-4000-8000-000000000002',
  issued_at: new Date(now - 1_000).toISOString(),
  expires_at: new Date(now + 60_000).toISOString(),
  venue_ids: ['30000000-0000-4000-8000-000000000003'],
  operational_assignments: { tables: [], stations: [] },
});
const signatureBytes = new Uint8Array(
  await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    keys.privateKey,
    new TextEncoder().encode(payload),
  ),
);
const signature = Buffer.from(signatureBytes).toString('base64url');
const trusted = {
  kty: 'EC',
  crv: 'P-256',
  x: publicKey.x,
  y: publicKey.y,
  ext: true,
  key_ops: ['verify'],
};
const record = authorizationSchema.parse({
  id: '30000000-0000-4000-8000-000000000004',
  payload,
  signature,
  public_key: trusted,
});
assert.ok(
  await verifyOfflineAuthorization(record, [trusted], now, now - 5_000),
  'valid signed authorization verifies',
);
assert.equal(
  await verifyOfflineAuthorization(record, [trusted], now + 61_000, now),
  undefined,
  'expired authorization rejected',
);
assert.equal(
  await verifyOfflineAuthorization(record, [trusted], now - 70_000, now),
  undefined,
  'clock rollback rejected',
);
assert.equal(
  await verifyOfflineAuthorization(record, [], now, now),
  undefined,
  'untrusted signing key rejected',
);
console.log('STEP8_VAULT_GATE=PASSED');
