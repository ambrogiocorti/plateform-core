import 'fake-indexeddb/auto';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDB } from 'idb';
import {
  enqueueOrder,
  enqueueStep,
  enqueueTableReset,
  queuedEvents,
  vaultPut,
} from '../../src/offline/store';
import { offlineWorkspaceKey } from '../../src/offline/workspace';
const user = '20000000-0000-4000-8000-000000000004',
  venue = '10000000-0000-4000-8000-000000000001',
  device = '40000000-0000-4000-8000-000000000001',
  account = '60000000-0000-4000-8000-000000000001',
  step = '60000000-0000-4000-8000-000000000002',
  table = '60000000-0000-4000-8000-000000000003';
describe('encrypted offline operational queue', () => {
  let pair: CryptoKeyPair, publicKey: JsonWebKey;
  beforeAll(async () => {
    pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
      'sign',
      'verify',
    ]);
    publicKey = await crypto.subtle.exportKey('jwk', pair.publicKey);
    vi.stubEnv('VITE_OFFLINE_PUBLIC_KEYS_JWK', JSON.stringify([publicKey]));
    vi.stubGlobal('navigator', {
      locks: { request: async (_name: string, callback: () => Promise<unknown>) => callback() },
    });
  });
  async function authorize(role = 'WAITER') {
    const now = Date.now(),
      claims = {
        user_id: user,
        device_id: device,
        role,
        scope: 'VENUE',
        issued_at: new Date(now - 1000).toISOString(),
        expires_at: new Date(now + 600000).toISOString(),
        venue_ids: [venue],
        operational_assignments: {
          tables: [{ venue_id: venue, table_id: table, zone_id: null, mode: 'TABLE' }],
          stations: [],
        },
      },
      payload = JSON.stringify(claims),
      signature = new Uint8Array(
        await crypto.subtle.sign(
          { name: 'ECDSA', hash: 'SHA-256' },
          pair.privateKey,
          new TextEncoder().encode(payload),
        ),
      );
    await vaultPut('authorization', {
      id: crypto.randomUUID(),
      payload,
      signature: btoa(String.fromCharCode(...signature))
        .replaceAll('+', '-')
        .replaceAll('/', '_')
        .replaceAll('=', ''),
      public_key: publicKey,
    });
  }
  beforeEach(async () => {
    await authorize();
    await vaultPut('clock', 0);
    await vaultPut('queue', []);
    await vaultPut(offlineWorkspaceKey(user, venue), {
      captured_at: new Date().toISOString(),
      floor: null,
      accounts: [{ id: account, name: 'Private group', version: 7, table_id: table }],
      steps: [{ id: step, version: 3, number: 2, table_name: '1', can_start: true }],
      reset_tables: [{ id: table, name: '1', version: 5 }],
      kitchen: [],
    });
  });
  it('persists an order encrypted and preserves its user, version and immutable idempotency key', async () => {
    const event = await enqueueOrder(venue, account, 7, [
      { dish_id: crypto.randomUUID(), quantity: 1 },
    ]);
    expect((await queuedEvents())[0]).toEqual(event);
    const db = await openDB('plateform-staff-offline'),
      stored = await db.get('vault', 'queue');
    expect(new TextDecoder().decode(stored.ciphertext)).not.toContain(account);
    expect(new TextDecoder().decode(stored.ciphertext)).not.toContain('CREATE_ORDER');
    db.close();
    await expect(enqueueOrder(venue, account, 7, [])).rejects.toThrow(
      'OFFLINE_RESOURCE_ALREADY_QUEUED',
    );
  });
  it('queues only the safe nonfinancial operations authorized by the captured workspace', async () => {
    expect((await enqueueStep(venue, step, 3)).resource_type).toBe('order_steps');
    expect((await enqueueTableReset(venue, table, 5)).resource_type).toBe('tables');
    await expect(enqueueStep(venue, crypto.randomUUID(), 3)).rejects.toThrow(
      'OFFLINE_OPERATION_FORBIDDEN',
    );
  });
  it('does not give Host an order command or let a stale revision masquerade as current', async () => {
    await authorize('HOST');
    await expect(enqueueOrder(venue, account, 7, [])).rejects.toThrow(
      'OFFLINE_OPERATION_FORBIDDEN',
    );
    await expect(enqueueStep(venue, step, 3)).rejects.toThrow('OFFLINE_OPERATION_FORBIDDEN');
    expect((await enqueueTableReset(venue, table, 5)).operation).toBe('SET_TABLE_AVAILABLE');
    await authorize();
    await expect(enqueueOrder(venue, account, 6, [])).rejects.toThrow(
      'OFFLINE_OPERATION_FORBIDDEN',
    );
  });
  it('does not overwrite another staff member’s unsynchronized queue on a shared device', async () => {
    const event = await enqueueOrder(venue, account, 7, []);
    await vaultPut('queue', [{ ...event, user_id: crypto.randomUUID() }]);
    await expect(enqueueStep(venue, step, 3)).rejects.toThrow('OFFLINE_OTHER_USER_QUEUE');
    expect(await queuedEvents()).toHaveLength(1);
  });
  it('preserves a corrupted queue and reports recovery instead of silently replacing it with an empty queue', async () => {
    await enqueueOrder(venue, account, 7, []);
    const db = await openDB('plateform-staff-offline');
    const encrypted = await db.get('vault', 'queue');
    const bytes = new Uint8Array(encrypted.ciphertext);
    bytes[0] = bytes[0]! ^ 1;
    await db.put('vault', { iv: encrypted.iv, ciphertext: bytes.buffer }, 'queue');
    await expect(queuedEvents()).rejects.toThrow('OFFLINE_QUEUE_UNREADABLE');
    await expect(enqueueStep(venue, step, 3)).rejects.toThrow('OFFLINE_QUEUE_UNREADABLE');
    expect(new Uint8Array((await db.get('vault', 'queue')).ciphertext)).toEqual(bytes);
    db.close();
  });
});
