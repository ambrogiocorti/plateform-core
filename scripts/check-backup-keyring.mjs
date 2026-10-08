import { loadEncryptionKeyring, resolveEncryptionKey } from '../tools/backup-worker/keyring.mjs';

const active = Buffer.alloc(32, 1).toString('base64');
const old = Buffer.alloc(32, 2).toString('base64');
const keys = loadEncryptionKeyring(
  'continuity-key-v2',
  active,
  JSON.stringify({ 'continuity-key-v1': old }),
);
if (keys.size !== 2) throw new Error('KEYRING_SIZE');
if (!resolveEncryptionKey(keys, 'continuity-key-v2').equals(Buffer.alloc(32, 1)))
  throw new Error('ACTIVE_KEY');
if (!resolveEncryptionKey(keys, 'continuity-key-v1').equals(Buffer.alloc(32, 2)))
  throw new Error('HISTORICAL_KEY');
let missing = '';
try {
  resolveEncryptionKey(keys, 'continuity-key-v0');
} catch (error) {
  missing = error.message;
}
if (!missing.startsWith('BACKUP_ENCRYPTION_KEY_UNAVAILABLE:'))
  throw new Error('MISSING_KEY_NOT_FAIL_CLOSED');
let mismatch = '';
try {
  loadEncryptionKeyring('continuity-key-v2', active, JSON.stringify({ 'continuity-key-v2': old }));
} catch (error) {
  mismatch = error.message;
}
if (mismatch !== 'CONFIG_KEYRING_ACTIVE_KEY_MISMATCH')
  throw new Error('ACTIVE_KEY_MISMATCH_NOT_REJECTED');
console.log('STEP12_BACKUP_KEYRING_ROTATION=PASSED');
console.log('STEP12_BACKUP_KEYRING_MISSING_KEY_FAIL_CLOSED=PASSED');
