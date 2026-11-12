import { readFile } from 'node:fs/promises';
const script = await readFile(
  new URL('../deploy/continuity/configure-continuity-env.sh', import.meta.url),
  'utf8',
);
const checks = [
  [
    'secret-prompts-no-echo',
    script.includes('read -r -s -p "Supabase server key') &&
      script.includes('read -r -s -p "PostgreSQL') &&
      script.includes('read -r -s -p "Backup encryption key'),
  ],
  [
    'no-secret-cli-args',
    !script.includes('--service-role-key') &&
      !script.includes('--db-password') &&
      !script.includes('--encryption-key '),
  ],
  [
    'atomic-temp-file',
    script.includes('mktemp "$CONFIG_DIR/.continuity.env.XXXXXX"') &&
      script.includes('mv -f "$TMP_FILE" "$ENV_FILE"'),
  ],
  [
    'permissions-0600',
    script.includes('chmod 600 "$TMP_FILE"') && script.includes('chmod 600 "$ENV_FILE"'),
  ],
  [
    'worker-parser-validation',
    script.includes("import { loadConfig } from './tools/backup-worker/config.mjs';") &&
      script.includes('const config=loadConfig();'),
  ],
  ['project-url-derived', script.includes('SUPABASE_URL=https://${project_ref}.supabase.co')],
  [
    'independent-roots-required',
    script.includes('Primary and replica roots must be distinct absolute paths.'),
  ],
  ['no-default-same-device-escape', script.includes('PLATEFORM_ALLOW_SAME_DEVICE_REPLICA=false')],
  ['no-rootful-default', script.includes('PLATEFORM_ALLOW_ROOTFUL_DOCKER=false')],
  ['secret-vars-unset', script.includes('unset server_key database_url encryption_key')],
];
const failed = checks.filter(([, ok]) => !ok).map(([name]) => name);
if (failed.length) throw new Error(`CONTINUITY_SECRET_CONFIG:${failed.join(',')}`);
console.log('STEP12_CONTINUITY_SECRET_CONFIG=PASSED');
