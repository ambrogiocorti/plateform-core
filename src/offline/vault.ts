import { openDB } from 'idb';
import { z } from 'zod';

const database = () =>
  openDB('plateform-staff-offline', 1, {
    upgrade(db) {
      db.createObjectStore('vault');
      db.createObjectStore('keys');
    },
  });

async function encryptionKey(): Promise<CryptoKey> {
  const db = await database();
  let stored = (await db.get('keys', 'encryption')) as CryptoKey | undefined;
  if (!stored) {
    const created = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
      'encrypt',
      'decrypt',
    ]);
    const tx = db.transaction('keys', 'readwrite');
    stored = (await tx.store.get('encryption')) as CryptoKey | undefined;
    if (!stored) {
      stored = created;
      await tx.store.put(stored, 'encryption');
    }
    await tx.done;
  }
  return stored;
}

export async function vaultPut(name: string, value: unknown): Promise<void> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(name) },
    await encryptionKey(),
    new TextEncoder().encode(JSON.stringify(value)),
  );
  const db = await database();
  await db.put('vault', { iv, ciphertext }, name);
}

export async function vaultGet<T>(name: string, schema: z.ZodType<T>): Promise<T | undefined> {
  const db = await database();
  const stored = (await db.get('vault', name)) as
    { iv: Uint8Array<ArrayBuffer>; ciphertext: ArrayBuffer } | undefined;
  if (!stored) return undefined;
  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: stored.iv, additionalData: new TextEncoder().encode(name) },
      await encryptionKey(),
      stored.ciphertext,
    );
    return schema.parse(JSON.parse(new TextDecoder().decode(plaintext)));
  } catch {
    if (name === 'queue') throw new Error('OFFLINE_QUEUE_UNREADABLE');
    return undefined;
  }
}

export async function clearOffline(): Promise<void> {
  const db = await database();
  const tx = db.transaction('vault', 'readwrite');
  for (const name of await tx.store.getAllKeys()) if (name !== 'queue') await tx.store.delete(name);
  await tx.done;
}
