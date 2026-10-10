import { loadConfig as loadBackupConfig } from '../tools/backup-worker/config.mjs';
import { loadConfig as loadRestoreTestConfig } from '../tools/restore-test-worker/config.mjs';
import { loadConfig as loadRestoreConfig } from '../tools/restore-worker/config.mjs';

const original = { ...process.env };
const key = Buffer.alloc(32, 7).toString('base64');
function serviceRoleJwt() {
  const enc = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${enc({ alg: 'HS256', typ: 'JWT' })}.${enc({ role: 'service_role', iss: 'supabase' })}.signature`;
}
function base() {
  Object.assign(process.env, {
    SUPABASE_URL: 'https://sourceprojectref.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: serviceRoleJwt(),
    SUPABASE_DB_URL:
      'postgresql://postgres.sourceprojectref:pw@aws-0-eu-west-1.pooler.supabase.com:5432/postgres',
    PLATEFORM_BACKUP_ROOT: '/tmp/plateform-binding-check',
    PLATEFORM_BACKUP_REPLICA_ROOT: '/tmp/plateform-binding-check-replica',
    PLATEFORM_BACKUP_ENCRYPTION_KEY_BASE64: key,
    PLATEFORM_BACKUP_ENCRYPTION_KEY_ID: 'continuity-key-v1',
    PLATEFORM_RESTORE_TEST_SUPABASE_URL: 'https://restoretestref.supabase.co',
    PLATEFORM_RESTORE_TEST_SERVICE_ROLE_KEY: serviceRoleJwt(),
    PLATEFORM_RESTORE_TEST_DB_URL:
      'postgresql://postgres.restoretestref:pw@aws-0-eu-west-1.pooler.supabase.com:5432/postgres',
    PLATEFORM_RESTORE_TEST_CONFIRM_PROJECT_REF: 'restoretestref',
    PLATEFORM_RESTORE_TEST_ALLOW_DESTRUCTIVE: 'true',
    PLATEFORM_RESTORE_TARGET_SUPABASE_URL: 'https://replacementref.supabase.co',
    PLATEFORM_RESTORE_TARGET_SERVICE_ROLE_KEY: serviceRoleJwt(),
    PLATEFORM_RESTORE_TARGET_DB_URL:
      'postgresql://postgres.replacementref:pw@aws-0-eu-west-1.pooler.supabase.com:5432/postgres',
    PLATEFORM_RESTORE_TARGET_CONFIRM_PROJECT_REF: 'replacementref',
    PLATEFORM_RESTORE_ALLOW_DESTRUCTIVE: 'true',
  });
}
function expectError(fn, prefix) {
  let message = '';
  try {
    fn();
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  if (!message.startsWith(prefix)) throw new Error(`EXPECTED_${prefix}:${message || 'NO_ERROR'}`);
}
try {
  base();
  if (loadBackupConfig().sourceProjectRef !== 'sourceprojectref')
    throw new Error('BACKUP_SOURCE_REF');
  if (loadRestoreTestConfig().targetProjectRef !== 'restoretestref')
    throw new Error('RESTORE_TEST_REF');
  if (loadRestoreConfig().targetProjectRef !== 'replacementref') throw new Error('RESTORE_REF');

  process.env.SUPABASE_DB_URL =
    'postgresql://postgres.otherref:pw@aws-0-eu-west-1.pooler.supabase.com:5432/postgres';
  expectError(loadBackupConfig, 'CONFIG_PROJECT_REF_MISMATCH:SUPABASE_DB_URL');

  base();
  process.env.PLATEFORM_RESTORE_TEST_DB_URL =
    'postgresql://postgres.otherref:pw@aws-0-eu-west-1.pooler.supabase.com:5432/postgres';
  expectError(loadRestoreTestConfig, 'RESTORE_TEST_DB_PROJECT_REF_MISMATCH');

  base();
  process.env.PLATEFORM_RESTORE_TEST_CONFIRM_PROJECT_REF = 'wrongref';
  expectError(loadRestoreTestConfig, 'RESTORE_TEST_TARGET_CONFIRMATION_MISMATCH');

  base();
  process.env.PLATEFORM_RESTORE_TARGET_DB_URL =
    'postgresql://postgres.otherref:pw@aws-0-eu-west-1.pooler.supabase.com:5432/postgres';
  expectError(loadRestoreConfig, 'RESTORE_DB_PROJECT_REF_MISMATCH');

  base();
  process.env.PLATEFORM_RESTORE_TARGET_DB_URL =
    'postgresql://postgres.replacementref:pw@attacker.example:5432/postgres';
  expectError(
    loadRestoreConfig,
    'CONFIG_DB_PROJECT_REF_UNDETECTABLE:PLATEFORM_RESTORE_TARGET_DB_URL',
  );

  base();
  process.env.PLATEFORM_RESTORE_TARGET_DB_URL =
    'postgresql://postgres.replacementref:pw@db.otherref.supabase.co:5432/postgres';
  expectError(
    loadRestoreConfig,
    'CONFIG_DB_PROJECT_REF_UNDETECTABLE:PLATEFORM_RESTORE_TARGET_DB_URL',
  );

  base();
  process.env.PLATEFORM_RESTORE_TARGET_DB_URL =
    'postgresql://postgres.replacementref@aws-0-eu-west-1.pooler.supabase.com:5432/postgres';
  expectError(loadRestoreConfig, 'CONFIG_INVALID:PLATEFORM_RESTORE_TARGET_DB_URL');

  base();
  process.env.PLATEFORM_RESTORE_TARGET_DB_URL =
    'postgresql://postgres:pw@db.replacementref.supabase.co:5432/postgres';
  if (loadRestoreConfig().targetProjectRef !== 'replacementref')
    throw new Error('RESTORE_DIRECT_CONNECTION_INVALID');

  base();
  process.env.PLATEFORM_RESTORE_TARGET_CONFIRM_PROJECT_REF = 'wrongref';
  expectError(loadRestoreConfig, 'RESTORE_TARGET_CONFIRMATION_MISMATCH');

  console.log('STEP12_CONTINUITY_PROJECT_BINDING=PASSED');
} finally {
  for (const keyName of Object.keys(process.env))
    if (!(keyName in original)) delete process.env[keyName];
  Object.assign(process.env, original);
}
