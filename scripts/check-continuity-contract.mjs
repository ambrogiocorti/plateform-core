import { readFile } from 'node:fs/promises';

const templatePath = new URL('../deploy/continuity/continuity.env.example', import.meta.url);
const backupConfigPath = new URL('../tools/backup-worker/config.mjs', import.meta.url);
const restoreTestConfigPath = new URL('../tools/restore-test-worker/config.mjs', import.meta.url);
const restoreConfigPath = new URL('../tools/restore-worker/config.mjs', import.meta.url);
const retentionConfigPath = new URL('../tools/backup-retention-worker/config.mjs', import.meta.url);

const [template, backupConfig, restoreTestConfig, restoreConfig, retentionConfig] =
  await Promise.all([
    readFile(templatePath, 'utf8'),
    readFile(backupConfigPath, 'utf8'),
    readFile(restoreTestConfigPath, 'utf8'),
    readFile(restoreConfigPath, 'utf8'),
    readFile(retentionConfigPath, 'utf8'),
  ]);

const declared = new Set(
  template
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*#\s?/, '').trim())
    .filter((line) => /^[A-Z][A-Z0-9_]*=/.test(line))
    .map((line) => line.slice(0, line.indexOf('='))),
);

function requiredNames(source) {
  return [...source.matchAll(/required\(['"]([A-Z][A-Z0-9_]*)['"]\)/g)].map((match) => match[1]);
}

const required = new Set([
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'SUPABASE_DB_URL',
  'PLATEFORM_BACKUP_ROOT',
  'PLATEFORM_BACKUP_ENCRYPTION_KEY_BASE64',
  'PLATEFORM_BACKUP_ENCRYPTION_KEY_ID',
  'PLATEFORM_RESTORE_TEST_SUPABASE_URL',
  'PLATEFORM_RESTORE_TEST_SERVICE_ROLE_KEY',
  'PLATEFORM_RESTORE_TEST_DB_URL',
  'PLATEFORM_RESTORE_TEST_CONFIRM_PROJECT_REF',
  'PLATEFORM_RESTORE_TARGET_SUPABASE_URL',
  'PLATEFORM_RESTORE_TARGET_SERVICE_ROLE_KEY',
  'PLATEFORM_RESTORE_TARGET_DB_URL',
  'PLATEFORM_RESTORE_TARGET_CONFIRM_PROJECT_REF',
  ...requiredNames(backupConfig),
  ...requiredNames(restoreTestConfig),
  ...requiredNames(restoreConfig),
  ...requiredNames(retentionConfig),
]);

const optional = new Set([
  'SUPABASE_CLI_BIN',
  'PSQL_BIN',
  'DOCKER_BIN',
  'DOCKER_HOST',
  'PLATEFORM_ALLOW_ROOTFUL_DOCKER',
  'PLATEFORM_ALLOW_SAME_DEVICE_REPLICA',
  'PLATEFORM_BACKUP_LEASE_SECONDS',
  'PLATEFORM_BACKUP_KEYRING_JSON',
  'PLATEFORM_RETENTION_LEASE_SECONDS',
  'PLATEFORM_RESTORE_TEST_LEASE_SECONDS',
  'PLATEFORM_RESTORE_LEASE_SECONDS',
  'PLATEFORM_RESTORE_TEST_ALLOW_DESTRUCTIVE',
  'PLATEFORM_RESTORE_ALLOW_DESTRUCTIVE',
]);

const missing = [...required].filter((name) => !declared.has(name)).sort();
for (const name of optional) {
  if (!declared.has(name)) missing.push(name);
}

const forbiddenLegacy = [
  'PLATEFORM_DATABASE_URL',
  'PLATEFORM_BACKUP_ENCRYPTION_KEY',
  'SUPABASE_BIN',
].filter((name) => declared.has(name));

if (missing.length || forbiddenLegacy.length) {
  console.error(JSON.stringify({ status: 'FAILED', missing, forbiddenLegacy }, null, 2));
  process.exit(1);
}

console.log(
  JSON.stringify(
    {
      status: 'PASSED',
      declaredVariables: declared.size,
      requiredVariables: [...required].sort(),
    },
    null,
    2,
  ),
);
