import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { readFile, stat, unlink } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';

export async function sha256File(path) {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

export function sha256Text(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function hmacSha256Text(value, key) {
  return createHmac('sha256', key).update(value).digest('hex');
}

export function verifyHmacSha256Text(value, key, expected) {
  const raw = String(expected ?? '')
    .trim()
    .toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(raw)) throw new Error('BACKUP_MANIFEST_AUTH_INVALID');
  const actual = hmacSha256Text(value, key);
  const left = Buffer.from(actual, 'hex'),
    right = Buffer.from(raw, 'hex');
  if (left.length !== right.length || !timingSafeEqual(left, right))
    throw new Error('BACKUP_MANIFEST_AUTH_MISMATCH');
  return true;
}

export async function encryptVerified(path, key) {
  const iv = randomBytes(12);
  const target = `${path}.enc`;
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  await pipeline(createReadStream(path), cipher, createWriteStream(target, { mode: 0o600 }));
  const tag = cipher.getAuthTag();
  const plainHash = await sha256File(path);

  const encrypted = await readFile(target);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const restored = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  const restoredHash = createHash('sha256').update(restored).digest('hex');
  if (restoredHash !== plainHash) {
    await unlink(target).catch(() => undefined);
    throw new Error('BACKUP_ENCRYPTION_VERIFY_FAILED');
  }
  const info = await stat(target);
  await unlink(path);
  return {
    path: target,
    sizeBytes: info.size,
    sha256: await sha256File(target),
    plaintextSha256: plainHash,
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    algorithm: 'AES-256-GCM',
  };
}

export async function decryptVerified(source, target, key, metadata) {
  const encryptedHash = await sha256File(source);
  if (encryptedHash !== metadata.sha256) throw new Error('BACKUP_CIPHERTEXT_CHECKSUM_MISMATCH');
  const encrypted = await readFile(source);
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(metadata.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(metadata.tag, 'base64'));
  let restored;
  try {
    restored = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  } catch {
    throw new Error('BACKUP_DECRYPTION_FAILED');
  }
  const plainHash = createHash('sha256').update(restored).digest('hex');
  if (plainHash !== metadata.plaintext_sha256)
    throw new Error('BACKUP_PLAINTEXT_CHECKSUM_MISMATCH');
  await import('node:fs/promises').then(({ writeFile }) =>
    writeFile(target, restored, { mode: 0o600 }),
  );
  return { path: target, sizeBytes: restored.length, sha256: plainHash };
}
