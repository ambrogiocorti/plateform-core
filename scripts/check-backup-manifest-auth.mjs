import { hmacSha256Text, verifyHmacSha256Text } from '../tools/backup-worker/crypto.mjs';

const key = Buffer.from([...Array(32).keys()]);
const other = Buffer.from([...Array(32).keys()].reverse());
const manifest = JSON.stringify({
  format_version: 2,
  backup_id: '11111111-1111-4111-8111-111111111111',
  manifest_auth: { algorithm: 'HMAC-SHA256', file: 'manifest.hmac' },
});
const tag = hmacSha256Text(manifest, key);
if (!/^[0-9a-f]{64}$/.test(tag)) throw new Error('MANIFEST_HMAC_FORMAT');
if (verifyHmacSha256Text(manifest, key, tag) !== true)
  throw new Error('MANIFEST_HMAC_VALID_REJECTED');
let tamper = '';
try {
  verifyHmacSha256Text(`${manifest} `, key, tag);
} catch (error) {
  tamper = error.message;
}
if (tamper !== 'BACKUP_MANIFEST_AUTH_MISMATCH')
  throw new Error(`MANIFEST_TAMPER_NOT_REJECTED:${tamper}`);
let wrong = '';
try {
  verifyHmacSha256Text(manifest, other, tag);
} catch (error) {
  wrong = error.message;
}
if (wrong !== 'BACKUP_MANIFEST_AUTH_MISMATCH')
  throw new Error(`MANIFEST_WRONG_KEY_NOT_REJECTED:${wrong}`);
let malformed = '';
try {
  verifyHmacSha256Text(manifest, key, 'abc');
} catch (error) {
  malformed = error.message;
}
if (malformed !== 'BACKUP_MANIFEST_AUTH_INVALID')
  throw new Error(`MANIFEST_BAD_TAG_NOT_REJECTED:${malformed}`);
console.log('STEP12_MANIFEST_HMAC_VALID=PASSED');
console.log('STEP12_MANIFEST_HMAC_TAMPER_REJECTED=PASSED');
console.log('STEP12_MANIFEST_HMAC_WRONG_KEY_REJECTED=PASSED');
console.log('STEP12_MANIFEST_HMAC_MALFORMED_REJECTED=PASSED');
