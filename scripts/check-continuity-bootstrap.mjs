import { readFile } from 'node:fs/promises';
const bootstrap = await readFile(
  new URL('../deploy/continuity/bootstrap-user-toolchain.sh', import.meta.url),
  'utf8',
);
const lock = await readFile(
  new URL('../deploy/continuity/toolchain.lock.env', import.meta.url),
  'utf8',
);
const installer = await readFile(
  new URL('../deploy/continuity/install-user-service.sh', import.meta.url),
  'utf8',
);
const doctor = await readFile(
  new URL('../scripts/check-continuity-host.mjs', import.meta.url),
  'utf8',
);
const checks = [
  [
    'node-pinned',
    lock.includes('PLATEFORM_CONTINUITY_NODE_VERSION=24.13.0') &&
      bootstrap.includes('SHASUMS256.txt') &&
      bootstrap.includes('sha256sum'),
  ],
  [
    'supabase-cli-pinned',
    lock.includes('PLATEFORM_CONTINUITY_SUPABASE_CLI_VERSION=2.119.0') &&
      bootstrap.includes('supabase-cli-${PLATEFORM_CONTINUITY_SUPABASE_CLI_VERSION}'),
  ],
  [
    'user-local-no-sudo',
    bootstrap.includes('LOCAL_BIN="$HOME/.local/bin"') && !bootstrap.includes('sudo '),
  ],
  [
    'psql-minimum',
    bootstrap.includes('PLATEFORM_CONTINUITY_MIN_PSQL_MAJOR') && bootstrap.includes('PSQL_MAJOR'),
  ],
  [
    'rootless-prerequisites',
    bootstrap.includes('newuidmap') &&
      bootstrap.includes('newgidmap') &&
      bootstrap.includes('/etc/subuid') &&
      bootstrap.includes('/etc/subgid'),
  ],
  [
    'rootless-setup',
    bootstrap.includes('dockerd-rootless-setuptool.sh install') &&
      bootstrap.includes('systemctl --user enable --now docker.service'),
  ],
  [
    'rootless-verification',
    bootstrap.includes('grep -qi rootless') &&
      bootstrap.includes('Docker daemon is not rootless after setup.'),
  ],
  ['docker-host-user-socket', bootstrap.includes('unix:///run/user/$(id -u)/docker.sock')],
  [
    'toolchain-env-0600',
    bootstrap.includes('toolchain.env') &&
      bootstrap.includes('chmod 600 "$CONFIG_DIR/toolchain.env"'),
  ],
  [
    'systemd-toolchain-dropin',
    installer.includes('EnvironmentFile=-$TOOLCHAIN_ENV_FILE') &&
      installer.includes('toolchain.conf'),
  ],
  [
    'doctor-cli-lock',
    doctor.includes('SUPABASE_CLI_VERSION_MISMATCH') &&
      doctor.includes('PLATEFORM_CONTINUITY_SUPABASE_CLI_VERSION'),
  ],
  [
    'doctor-psql-minimum',
    doctor.includes('PSQL_VERSION_UNSUPPORTED') &&
      doctor.includes('PLATEFORM_CONTINUITY_MIN_PSQL_MAJOR'),
  ],
];
const failed = checks.filter(([, ok]) => !ok).map(([name]) => name);
if (failed.length) throw new Error(`CONTINUITY_BOOTSTRAP:${failed.join(',')}`);
console.log('STEP12_CONTINUITY_BOOTSTRAP=PASSED');
