import { readFile } from 'node:fs/promises';
const activate = await readFile(
  new URL('../deploy/continuity/activate-user-service.sh', import.meta.url),
  'utf8',
);
const deactivate = await readFile(
  new URL('../deploy/continuity/deactivate-user-service.sh', import.meta.url),
  'utf8',
);
const checks = [
  [
    'requires-both-env-files',
    activate.includes('continuity.env') && activate.includes('toolchain.env'),
  ],
  ['requires-0600', activate.includes('expected 600') && activate.includes("stat -c '%a'")],
  ['rejects-placeholders', activate.includes('continuity.env still contains placeholder values.')],
  [
    'loads-toolchain-before-continuity',
    activate.indexOf('source "$TOOLCHAIN_ENV_FILE"') < activate.indexOf('source "$ENV_FILE"'),
  ],
  [
    'doctor-before-enable',
    activate.indexOf('check-continuity-host.mjs') <
      activate.indexOf('systemctl --user enable --now'),
  ],
  [
    'backup-check-before-enable',
    activate.indexOf('backup-worker/start.mjs --check') <
      activate.indexOf('systemctl --user enable --now'),
  ],
  [
    'retention-check-before-enable',
    activate.indexOf('backup-retention-worker/start.mjs --check') <
      activate.indexOf('systemctl --user enable --now'),
  ],
  ['verifies-enabled', activate.includes('systemctl --user is-enabled')],
  ['verifies-active', activate.includes('systemctl --user is-active')],
  [
    'deactivate-supported',
    deactivate.includes(
      'disable --now plateform-backup-worker.timer plateform-backup-retention-worker.timer',
    ),
  ],
];
const failed = checks.filter(([, ok]) => !ok).map(([name]) => name);
if (failed.length) throw new Error(`CONTINUITY_ACTIVATION:${failed.join(',')}`);
console.log('STEP12_CONTINUITY_ACTIVATION_GATE=PASSED');
