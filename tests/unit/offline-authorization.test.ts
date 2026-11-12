import { beforeAll, describe, expect, it } from 'vitest';
import {
  authorizationSchema,
  verificationKeySchema,
  verifyOfflineAuthorization,
} from '../../src/offline/authorization';
const at = Date.parse('2026-10-03T10:00:00Z');
const claims = {
  user_id: '20000000-0000-4000-8000-000000000004',
  device_id: '40000000-0000-4000-8000-000000000001',
  role: 'WAITER',
  scope: 'VENUE',
  issued_at: new Date(at).toISOString(),
  expires_at: new Date(at + 30 * 60000).toISOString(),
  venue_ids: ['10000000-0000-4000-8000-000000000001'],
  operational_assignments: { tables: [], stations: [] },
};
describe('offline trust anchor', () => {
  let pair: CryptoKeyPair, publicKey: ReturnType<typeof verificationKeySchema.parse>;
  beforeAll(async () => {
    pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
      'sign',
      'verify',
    ]);
    publicKey = verificationKeySchema.parse(await crypto.subtle.exportKey('jwk', pair.publicKey));
  });
  async function record(signing = pair, values = claims) {
    const signature = new Uint8Array(
      await crypto.subtle.sign(
        { name: 'ECDSA', hash: 'SHA-256' },
        signing.privateKey,
        new TextEncoder().encode(JSON.stringify(values)),
      ),
    );
    return authorizationSchema.parse({
      id: crypto.randomUUID(),
      payload: JSON.stringify(values),
      public_key: await crypto.subtle.exportKey('jwk', signing.publicKey),
      signature: btoa(String.fromCharCode(...signature))
        .replaceAll('+', '-')
        .replaceAll('/', '_')
        .replaceAll('=', ''),
    });
  }
  it('accepts an unexpired server signature using the configured public key', async () => {
    expect(await verifyOfflineAuthorization(await record(), [publicKey], at + 60000)).toEqual(
      claims,
    );
  });
  it('rejects a locally replaced key even if its forged signature is mathematically valid', async () => {
    const attacker = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
      'sign',
      'verify',
    ]);
    expect(
      await verifyOfflineAuthorization(await record(attacker), [publicKey], at + 60000),
    ).toBeUndefined();
  });
  it('rejects edited claims, expired access and a clock moved backwards', async () => {
    const signed = await record();
    expect(
      await verifyOfflineAuthorization(
        { ...signed, payload: signed.payload.replace('WAITER', 'ADMIN') },
        [publicKey],
        at + 60000,
      ),
    ).toBeUndefined();
    expect(await verifyOfflineAuthorization(signed, [publicKey], at + 30 * 60000)).toBeUndefined();
    expect(
      await verifyOfflineAuthorization(signed, [publicKey], at + 60000, at + 5 * 60000),
    ).toBeUndefined();
  });
  it('requires a public trust anchor and rejects accidentally configured private keys', async () => {
    expect(await verifyOfflineAuthorization(await record(), [], at + 60000)).toBeUndefined();
    expect(
      verificationKeySchema.safeParse(await crypto.subtle.exportKey('jwk', pair.privateKey))
        .success,
    ).toBe(false);
  });
});
