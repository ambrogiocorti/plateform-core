// Offline disaster restore CLI. Use ONLY when the source installation is lost
// and an empty replacement Supabase project has been provisioned. It never
// touches the (lost) source; it refuses an occupied target.
//
//   PLATEFORM_DR_BACKUP_DIR=/mnt/replica/<backup-uuid>
//   PLATEFORM_DR_TARGET_SUPABASE_URL=https://<ref>.supabase.co
//   PLATEFORM_DR_TARGET_DB_URL=postgresql://postgres.<ref>:...@...
//   PLATEFORM_DR_TARGET_SERVICE_ROLE_KEY=...
//   PLATEFORM_DR_CONFIRM_PROJECT_REF=<ref>          (must equal the target ref)
//   PLATEFORM_DR_OPERATOR_ID=<Super Admin staff uuid recorded on the restore>
//   PLATEFORM_DR_ALLOW_DESTRUCTIVE=true
//   PLATEFORM_BACKUP_ENCRYPTION_KEY_ID / _BASE64 [/ PLATEFORM_BACKUP_KEYRING_JSON]
//
//   node tools/disaster-restore/start.mjs --check | --restore | --activate-schedules
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import { assertSupabaseServerKey } from '../continuity/server-key.mjs';
import { loadEncryptionKeyring } from '../backup-worker/keyring.mjs';
import { activateSchedules, disasterRestore, loadAuthenticatedBackup } from './restore.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`CONFIG_REQUIRED:${name}`);
  return value;
}

function loadConfig() {
  const backupDir = required('PLATEFORM_DR_BACKUP_DIR');
  if (!isAbsolute(backupDir)) throw new Error('CONFIG_INVALID:PLATEFORM_DR_BACKUP_DIR');
  const targetUrl = new URL(required('PLATEFORM_DR_TARGET_SUPABASE_URL'));
  const ref = targetUrl.hostname.toLowerCase().match(/^([a-z0-9]+)\.supabase\.co$/)?.[1];
  if (targetUrl.protocol !== 'https:' || !ref)
    throw new Error('CONFIG_CANONICAL_PROJECT_URL_REQUIRED:PLATEFORM_DR_TARGET_SUPABASE_URL');
  const targetDatabaseUrl = required('PLATEFORM_DR_TARGET_DB_URL');
  const db = new URL(targetDatabaseUrl);
  const dbRefs = [
    db.hostname.toLowerCase().match(/^db\.([a-z0-9]+)\.supabase\.co$/)?.[1],
    decodeURIComponent(db.username)
      .match(/^postgres\.([a-z0-9]+)$/i)?.[1]
      ?.toLowerCase(),
  ].filter(Boolean);
  if (!dbRefs.length || dbRefs.some((value) => value !== ref))
    throw new Error('DISASTER_RESTORE_DB_PROJECT_REF_MISMATCH');
  if (required('PLATEFORM_DR_CONFIRM_PROJECT_REF') !== ref)
    throw new Error('DISASTER_RESTORE_TARGET_CONFIRMATION_MISMATCH');
  if (process.env.PLATEFORM_DR_ALLOW_DESTRUCTIVE !== 'true')
    throw new Error('DISASTER_RESTORE_DESTRUCTIVE_ACK_REQUIRED');
  const operatorId = required('PLATEFORM_DR_OPERATOR_ID');
  if (!UUID.test(operatorId)) throw new Error('CONFIG_INVALID:PLATEFORM_DR_OPERATOR_ID');
  return {
    backupDir: resolve(backupDir),
    encryptionKeys: loadEncryptionKeyring(
      required('PLATEFORM_BACKUP_ENCRYPTION_KEY_ID'),
      required('PLATEFORM_BACKUP_ENCRYPTION_KEY_BASE64'),
    ),
    targetUrl: targetUrl.toString().replace(/\/$/, ''),
    targetServiceRoleKey: assertSupabaseServerKey(
      'PLATEFORM_DR_TARGET_SERVICE_ROLE_KEY',
      required('PLATEFORM_DR_TARGET_SERVICE_ROLE_KEY'),
    ),
    targetDatabaseUrl,
    targetProjectRef: ref,
    targetReference: `supabase://${ref}/disaster-restore`,
    operatorId,
    psql: process.env.PSQL_BIN?.trim() || 'psql',
  };
}

const mode = process.argv[2] ?? '--check';
const config = loadConfig();
const temp = await mkdtemp(`${tmpdir()}/plateform-disaster-restore-`);
try {
  if (mode === '--check') {
    const backup = await loadAuthenticatedBackup(config.backupDir, config.encryptionKeys);
    console.log(
      JSON.stringify({
        status: 'READY',
        backupId: backup.id,
        createdAt: backup.manifest.created_at,
        schemaVersion: backup.manifest.components?.migrations?.latest_version,
        target: config.targetProjectRef,
      }),
    );
  } else if (mode === '--restore') {
    const { createClient } = await import('@supabase/supabase-js');
    const result = await disasterRestore({ ...config, temp }, createClient);
    console.log(
      JSON.stringify({
        status: 'CUTOVER_REQUIRED',
        backupId: result.backupId,
        restoreJob: result.registration,
        schedulesPending: result.schedulesPending.length,
      }),
    );
  } else if (mode === '--activate-schedules') {
    console.log(
      JSON.stringify({
        status: 'SCHEDULES_ACTIVE',
        ...(await activateSchedules({ ...config, temp })),
      }),
    );
  } else throw new Error('USAGE: disaster-restore --check|--restore|--activate-schedules');
} finally {
  await rm(temp, { recursive: true, force: true });
}
