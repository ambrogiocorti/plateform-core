import { readFile } from 'node:fs/promises';
const installer = await readFile(
  new URL('../deploy/continuity/install-user-service.sh', import.meta.url),
  'utf8',
);
const backupService = await readFile(
  new URL('../deploy/continuity/plateform-backup-worker.service', import.meta.url),
  'utf8',
);
const retentionService = await readFile(
  new URL('../deploy/continuity/plateform-backup-retention-worker.service', import.meta.url),
  'utf8',
);
const env = await readFile(
  new URL('../deploy/continuity/continuity.env.example', import.meta.url),
  'utf8',
);
const checks = [
  ['replica-arg', installer.includes('REPLICA_ROOT="${2:-}"')],
  [
    'replica-absolute',
    installer.includes('Replica root must be an absolute path on an independent filesystem/mount.'),
  ],
  ['replica-no-whitespace', installer.includes('Replica root must not contain whitespace.')],
  [
    'no-python-runtime-dependency',
    !installer.includes('python3') && installer.includes('awk -v primary='),
  ],
  [
    'no-default-same-device-replica',
    !installer.includes('$HOME/.local/share/plateform/backups-replica'),
  ],
  [
    'env-primary-real-home',
    installer.includes('PLATEFORM_BACKUP_ROOT=') && installer.includes('primary="$PRIMARY_ROOT"'),
  ],
  ['env-replica-explicit', installer.includes('REPLACE_WITH_INDEPENDENT_ABSOLUTE_PATH')],
  ['systemd-replica-dropin', installer.includes('ReadWritePaths=$REPLICA_ROOT')],
  [
    'backup-service-primary-only',
    backupService.includes('ReadWritePaths=%h/.local/share/plateform/backups') &&
      !backupService.includes('backups-replica'),
  ],
  [
    'retention-service-primary-only',
    retentionService.includes('ReadWritePaths=%h/.local/share/plateform/backups') &&
      !retentionService.includes('backups-replica'),
  ],
  [
    'env-independent-mount-example',
    env.includes('PLATEFORM_BACKUP_REPLICA_ROOT=/mnt/plateform-backup-replica'),
  ],
];
const failed = checks.filter(([, ok]) => !ok).map(([name]) => name);
if (failed.length) throw new Error(`CONTINUITY_INSTALLER:${failed.join(',')}`);
console.log('STEP12_CONTINUITY_INSTALLER_INDEPENDENT_REPLICA=PASSED');
