import { finishBackupSuccess } from '../tools/backup-worker/protocol.mjs';

const originalFetch = globalThis.fetch;
const config = { supabaseUrl: 'https://projectref.supabase.co', serviceRoleKey: 'server-secret' };
const input = {
  id: '123e4567-e89b-42d3-a456-426614174000',
  leaseToken: '223e4567-e89b-42d3-a456-426614174000',
  databaseReference:
    'plateform-backup://123e4567-e89b-42d3-a456-426614174000/manifest.json#database',
  authReference: 'plateform-backup://123e4567-e89b-42d3-a456-426614174000/manifest.json#auth',
  storageReference: 'plateform-backup://123e4567-e89b-42d3-a456-426614174000/manifest.json#storage',
  manifest: {},
  verification: {},
  checksum: 'ab'.repeat(32),
  sizeBytes: 123,
  objectCount: 0,
  encryptionKeyId: 'test-key',
};
const response = (status, body = '') => ({
  ok: status >= 200 && status < 300,
  status,
  async text() {
    return body;
  },
});
try {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    if (calls === 1) throw new Error('socket closed after server commit');
    return response(
      200,
      JSON.stringify([
        {
          id: input.id,
          status: 'SUCCEEDED',
          checksum: input.checksum,
          integrity_verified: true,
          error_code: null,
        },
      ]),
    );
  };
  const reconciled = await finishBackupSuccess(config, input);
  if (reconciled.reconciled !== true || calls !== 2)
    throw new Error('COMMITTED_RESPONSE_LOSS_NOT_RECONCILED');

  calls = 0;
  globalThis.fetch = async () => {
    calls++;
    if (calls === 1) return response(503, 'upstream unavailable');
    return response(
      200,
      JSON.stringify([
        {
          id: input.id,
          status: 'RUNNING',
          checksum: null,
          integrity_verified: false,
          error_code: null,
        },
      ]),
    );
  };
  let notCommitted = false;
  try {
    await finishBackupSuccess(config, input);
  } catch (error) {
    notCommitted = String(error.message).startsWith('RPC_FAILED:finish_backup_job:503');
  }
  if (!notCommitted) throw new Error('NON_COMMITTED_STATE_NOT_PROPAGATED');

  calls = 0;
  globalThis.fetch = async () => {
    calls++;
    throw new Error(calls === 1 ? 'commit response lost' : 'state endpoint unreachable');
  };
  let ambiguous = false;
  try {
    await finishBackupSuccess(config, input);
  } catch (error) {
    ambiguous = error.message === 'BACKUP_COMMIT_AMBIGUOUS';
  }
  if (!ambiguous) throw new Error('AMBIGUOUS_COMMIT_NOT_PRESERVED');

  calls = 0;
  globalThis.fetch = async () => {
    calls++;
    if (calls === 1) throw new Error('response lost');
    return response(
      200,
      JSON.stringify([
        {
          id: input.id,
          status: 'SUCCEEDED',
          checksum: 'cd'.repeat(32),
          integrity_verified: true,
          error_code: null,
        },
      ]),
    );
  };
  let mismatch = false;
  try {
    await finishBackupSuccess(config, input);
  } catch (error) {
    mismatch = error.message === 'BACKUP_COMMIT_STATE_MISMATCH';
  }
  if (!mismatch) throw new Error('COMMIT_STATE_MISMATCH_NOT_FAIL_CLOSED');

  console.log('STEP12_BACKUP_AMBIGUOUS_COMMIT_RECONCILIATION=PASSED');
  console.log('STEP12_BACKUP_NON_COMMITTED_RETRY_PATH=PASSED');
  console.log('STEP12_BACKUP_UNKNOWN_COMMIT_PRESERVES_ARTIFACTS=PASSED');
  console.log('STEP12_BACKUP_COMMIT_STATE_MISMATCH_FAIL_CLOSED=PASSED');
} finally {
  globalThis.fetch = originalFetch;
}
