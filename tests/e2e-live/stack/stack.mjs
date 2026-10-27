// Disposable local stack for the live browser suite (no Docker required):
//   PostgreSQL 16+ (local binaries) + GoTrue (supabase/auth) + PostgREST + a tiny gateway.
// When a Docker daemon is reachable (and E2E_STORAGE is not 'off') it also runs the real
// Supabase storage-api, file backend, so uploads are exercised end to end; otherwise the
// storage schema stays an SQL fixture and the upload spec skips itself.
// Commands: install | up | reset | down. Data lives under E2E_STACK_DIR (default /tmp/plateform-e2e)
// and is recreated from a template database on every `reset`. It never targets remote databases.
import { execFileSync, spawn } from 'node:child_process';
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const root = resolve(import.meta.dirname, '../../..');
const dir = process.env.E2E_STACK_DIR ?? '/tmp/plateform-e2e';
const bin = join(dir, 'bin');
const pgBin = process.env.E2E_POSTGRES_BIN ?? '/usr/lib/postgresql/16/bin';
const port = 54322;
const db = 'plateform_e2e';
const template = 'plateform_e2e_template';
const jwtSecret = 'local-e2e-jwt-secret-not-for-production-0123456789';
const versions = { postgrest: 'v12.2.12', gotrue: 'v2.180.0' };
const storageApi = { image: 'supabase/storage-api:v1.28.0', container: 'plateform-e2e-storage' };
const asPostgres = process.getuid?.() === 0 ? ['runuser', '-u', 'postgres', '--'] : [];

function run(command, args, options = {}) {
  const [file, ...rest] = [...asPostgres, command, ...args];
  return execFileSync(file, rest, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  });
}
const url = (name) => `postgres://postgres@127.0.0.1:${port}/${name}`;
const psql = (name, sql) =>
  execFileSync('psql', [url(name), '-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1', '-c', sql], {
    encoding: 'utf8',
  }).trim();

function download(target, address, extract) {
  if (existsSync(target)) return;
  mkdirSync(bin, { recursive: true });
  const archive = join(bin, 'download.tmp');
  execFileSync('curl', ['-sSfL', '-o', archive, address], { stdio: 'inherit' });
  execFileSync('tar', [extract, '-xf', archive, '-C', bin], { stdio: 'inherit' });
}

export function install() {
  download(
    join(bin, 'postgrest'),
    `https://github.com/PostgREST/postgrest/releases/download/${versions.postgrest}/postgrest-${versions.postgrest}-linux-static-x86-64.tar.xz`,
    '-J',
  );
  download(
    join(bin, 'auth'),
    `https://github.com/supabase/auth/releases/download/${versions.gotrue}/auth-${versions.gotrue}-x86.tar.gz`,
    '-z',
  );
}

function daemon(name, command, args, env = {}) {
  const log = join(dir, `${name}.log`);
  const child = spawn('sh', ['-c', `exec "$0" "$@" >>"${log}" 2>&1`, command, ...args], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, ...env },
  });
  child.unref();
  writeFileSync(join(dir, `${name}.pid`), String(child.pid));
}

async function waitFor(address) {
  // GitHub-hosted runners can need more than 20 seconds to initialize
  // PostgREST and its schema cache immediately after 496 migrations.
  // Time-bound each probe so a stalled TCP connection cannot hang CI.
  const deadline = Date.now() + 90000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(address, { signal: AbortSignal.timeout(2500) });
      if (response.status < 500) return;
      lastError = `HTTP_${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.name : 'FETCH_FAILED';
    }
    await sleep(300);
  }
  throw new Error(`E2E_SERVICE_START_TIMEOUT:${new URL(address).pathname}:${lastError}`);
}

const gotrueEnv = (database) => ({
  GOTRUE_DB_DRIVER: 'postgres',
  DATABASE_URL: `postgres://supabase_auth_admin:local-e2e-auth-admin@127.0.0.1:${port}/${database}?search_path=auth`,
  GOTRUE_DB_MIGRATIONS_PATH: join(bin, 'migrations'),
  GOTRUE_JWT_SECRET: jwtSecret,
  GOTRUE_JWT_EXP: '900',
  GOTRUE_JWT_AUD: 'authenticated',
  GOTRUE_JWT_ADMIN_ROLES: 'service_role',
  GOTRUE_JWT_DEFAULT_GROUP_NAME: 'authenticated',
  GOTRUE_API_HOST: '127.0.0.1',
  PORT: '9999',
  API_EXTERNAL_URL: 'http://127.0.0.1:54321/auth/v1',
  GOTRUE_SITE_URL: 'http://localhost:5174',
  GOTRUE_DISABLE_SIGNUP: 'true',
  GOTRUE_EXTERNAL_EMAIL_ENABLED: 'true',
  GOTRUE_MAILER_AUTOCONFIRM: 'true',
  GOTRUE_MFA_TOTP_ENROLL_ENABLED: 'true',
  GOTRUE_MFA_TOTP_VERIFY_ENABLED: 'true',
  GOTRUE_PASSWORD_MIN_LENGTH: '12',
  GOTRUE_RATE_LIMIT_VERIFY: '1000',
  GOTRUE_RATE_LIMIT_TOKEN_REFRESH: '1000',
});

// Edge Functions the browser suite needs, served by the repository's Deno behind the gateway.
const functionPorts = {
  'offline-authorization': 54341,
  reservation: 54342,
  'asset-upload': 54343,
  // Scheduled workers, invoked by the specs exactly as pg_net would (tests/e2e-live/workers-live.spec.ts).
  'reservation-message-worker': 54344,
  'reservation-deposit-no-show-worker': 54345,
  'continuity-retention-worker': 54346,
  'audit-archive-worker': 54347,
  'audit-archive-verify': 54348,
  'database-unavailable-chaos-probe': 54349,
  // Large-group booking deposit checkout/status (tests/e2e-live/large-group-deposit-live.spec.ts).
  'reservation-deposit': 54352,
};
const ports = {
  gateway: 54321,
  gatewayTls: 54320,
  postgrest: 54330,
  gotrue: 9999,
  storage: 54350,
  ...Object.fromEntries(Object.entries(functionPorts).map(([name, port]) => [`fn-${name}`, port])),
};

function stop(name) {
  const file = join(dir, `${name}.pid`);
  if (existsSync(file))
    try {
      process.kill(Number(readFileSync(file, 'utf8')), 'SIGTERM');
    } catch {
      /* already stopped */
    }
  // Also release the port in case an earlier run left an orphan listener behind.
  try {
    execFileSync('fuser', ['-s', '-k', '-TERM', `${ports[name]}/tcp`]);
  } catch {
    /* nothing listening */
  }
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      execFileSync('fuser', ['-s', `${ports[name]}/tcp`]);
      execFileSync('sleep', ['0.1']);
    } catch {
      return;
    }
  }
}

function startPostgres() {
  const data = join(dir, 'data');
  if (!existsSync(data)) {
    mkdirSync(dir, { recursive: true });
    chmodSync(dir, 0o777);
    run(join(pgBin, 'initdb'), [
      '-D',
      data,
      '-U',
      'postgres',
      '--auth=trust',
      '-E',
      'UTF8',
      '--locale=C.UTF-8',
    ]);
  }
  try {
    run(join(pgBin, 'pg_ctl'), ['-D', data, 'status']);
  } catch {
    run(join(pgBin, 'pg_ctl'), [
      '-D',
      data,
      '-w',
      '-l',
      join(dir, 'postgres.log'),
      '-o',
      `-p ${port} -k ${dir} -c listen_addresses=127.0.0.1 -c wal_level=logical -c max_connections=200`,
      'start',
    ]);
  }
}

let dockerChecked;
function realStorage() {
  const storage = process.env.E2E_STORAGE;
  if (storage === 'off') return false;
  if (storage && !['auto', 'required'].includes(storage))
    throw new Error('E2E_STORAGE_MODE_INVALID');
  if (dockerChecked === undefined)
    try {
      execFileSync('docker', ['info'], { stdio: 'ignore', timeout: 15000 });
      dockerChecked = true;
    } catch {
      dockerChecked = false;
    }
  if (!dockerChecked && storage === 'required')
    throw new Error('E2E_STORAGE_REQUIRED_DOCKER_UNAVAILABLE');
  return dockerChecked;
}

function stopStorage() {
  try {
    execFileSync('docker', ['rm', '-f', storageApi.container], { stdio: 'ignore' });
  } catch {
    /* not running */
  }
}

// storage-api migrates the storage schema of `database` on start, then serves /storage/v1.
async function startStorage(database) {
  stopStorage();
  const { anonKey, serviceKey } = await import('./seed.mjs');
  const files = join(dir, 'storage');
  mkdirSync(files, { recursive: true });
  const env = {
    SERVER_PORT: String(ports.storage),
    PORT: String(ports.storage),
    DATABASE_URL: url(database),
    DB_INSTALL_ROLES: 'false',
    DATABASE_SEARCH_PATH: 'storage',
    AUTH_JWT_SECRET: jwtSecret,
    PGRST_JWT_SECRET: jwtSecret,
    ANON_KEY: anonKey,
    SERVICE_KEY: serviceKey,
    STORAGE_BACKEND: 'file',
    // Hosted Supabase's global upload limit (50 MB); buckets without their own limit fall back to it.
    FILE_SIZE_LIMIT: '52428800',
    FILE_STORAGE_BACKEND_PATH: '/var/lib/storage',
    TENANT_ID: 'stub',
    REGION: 'local',
    GLOBAL_S3_BUCKET: 'stub',
  };
  execFileSync(
    'docker',
    [
      'run',
      '-d',
      '--name',
      storageApi.container,
      '--network',
      'host',
      '-v',
      `${files}:/var/lib/storage`,
      ...Object.entries(env).flatMap(([key, value]) => ['-e', `${key}=${value}`]),
      storageApi.image,
    ],
    { stdio: 'ignore' },
  );
  await waitFor(`http://127.0.0.1:${ports.storage}/status`);
}

// The template is rebuilt whenever migrations, bootstrap, seed or the storage mode change.
function fingerprint() {
  const hash = createHash('sha256').update(realStorage() ? storageApi.image : 'storage-stub');
  const migrations = join(root, 'supabase/migrations');
  for (const name of readdirSync(migrations).sort())
    hash.update(name).update(readFileSync(join(migrations, name)));
  for (const name of ['bootstrap.sql', 'seed.mjs', 'apply-migrations.sh'])
    hash.update(readFileSync(join(import.meta.dirname, name)));
  return hash.digest('hex').slice(0, 16);
}

async function buildTemplate() {
  const expected = fingerprint();
  const current = psql(
    'postgres',
    `select shobj_description(oid,'pg_database') from pg_database where datname='${template}'`,
  );
  if (current === expected) return;
  psql('postgres', `drop database if exists ${template} with (force)`);
  let [roles, storageGrants] = readFileSync(
    join(import.meta.dirname, 'bootstrap.sql'),
    'utf8',
  ).split('-- after storage-api --');
  if (realStorage()) roles = roles.replace(/-- storage stub --[\s\S]*-- end storage stub --\n/, '');
  for (const name of ['postgrest', 'gotrue', 'gateway']) stop(name);
  psql('postgres', `drop database if exists ${template}_build with (force)`);
  psql('postgres', `create database ${template}_build`);
  // Cluster-wide roles exist once; the remaining bootstrap is per database.
  const [globalPart, databasePart] = roles.split('-- per-database --');
  if (!psql('postgres', "select 1 from pg_roles where rolname='authenticator'"))
    execFileSync('psql', [url('postgres'), '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-c', globalPart]);
  execFileSync('psql', [
    url(`${template}_build`),
    '-X',
    '-q',
    '-v',
    'ON_ERROR_STOP=1',
    '-c',
    databasePart,
  ]);
  // GoTrue owns and migrates the real auth schema.
  daemon('gotrue', join(bin, 'auth'), [], gotrueEnv(`${template}_build`));
  await waitFor('http://127.0.0.1:9999/health');
  psql(
    `${template}_build`,
    'grant usage on schema auth to anon,authenticated,service_role; grant execute on all functions in schema auth to anon,authenticated,service_role;',
  );
  if (realStorage()) {
    psql(
      'postgres',
      "do $$ begin if not exists(select 1 from pg_roles where rolname='supabase_storage_admin') then create role supabase_storage_admin login noinherit createrole; end if; end $$",
    );
    // seed.mjs fixes its database URL on first import, which startStorage triggers.
    process.env.E2E_DB_URL = url(`${template}_build`);
    await startStorage(`${template}_build`);
    stopStorage();
    execFileSync('psql', [
      url(`${template}_build`),
      '-X',
      '-q',
      '-v',
      'ON_ERROR_STOP=1',
      '-c',
      storageGrants,
    ]);
  }
  execFileSync(join(import.meta.dirname, 'apply-migrations.sh'), [], {
    stdio: 'inherit',
    env: { ...process.env, E2E_DB_URL: url(`${template}_build`) },
  });
  daemon('postgrest', join(bin, 'postgrest'), [postgrestConfig(`${template}_build`)]);
  daemon('gateway', process.execPath, [join(import.meta.dirname, 'gateway.mjs')]);
  await waitFor('http://127.0.0.1:54321/rest/v1/');
  process.env.E2E_DB_URL = url(`${template}_build`);
  const { seed } = await import('./seed.mjs');
  await seed();
  delete process.env.E2E_DB_URL;
  for (const name of ['postgrest', 'gotrue', 'gateway']) stop(name);
  await sleep(500);
  psql('postgres', `alter database ${template}_build rename to ${template}`);
  psql('postgres', `comment on database ${template} is '${expected}'`);
}

function postgrestConfig(database) {
  const file = join(dir, 'postgrest.conf');
  writeFileSync(
    file,
    [
      `db-uri = "postgres://authenticator:local-e2e-authenticator@127.0.0.1:${port}/${database}"`,
      'db-schemas = "public"',
      'db-extra-search-path = "public, extensions"',
      'db-anon-role = "anon"',
      'db-max-rows = 500',
      `jwt-secret = "${jwtSecret}"`,
      'server-host = "127.0.0.1"',
      'server-port = 54330',
    ].join('\n'),
  );
  return file;
}

export async function reset() {
  for (const name of ['postgrest', 'gotrue']) stop(name);
  await sleep(300);
  psql('postgres', `drop database if exists ${db} with (force)`);
  psql('postgres', `create database ${db} template ${template}`);
  // The template persists across midnight. Refresh disposable fixture stock dates
  // to each venue's local calendar day on every reset, never on customer databases.
  psql(
    db,
    `update public.venue_dish_settings s
    set availability_date=(now() at time zone v.timezone)::date
    from public.venues v
    where s.venue_id=v.id and s.availability is not null`,
  );
  daemon('gotrue', join(bin, 'auth'), [], gotrueEnv(db));
  daemon('postgrest', join(bin, 'postgrest'), [postgrestConfig(db)]);
  await waitFor('http://127.0.0.1:9999/health');
  await waitFor('http://127.0.0.1:54330/');
  // storage-api reconnects to the recreated database on its own; start it if it is not up.
  if (realStorage())
    try {
      await fetch(`http://127.0.0.1:${ports.storage}/status`);
    } catch {
      await startStorage(db);
    }
}

export async function up() {
  install();
  startPostgres();
  await buildTemplate();
  stop('gateway');
  daemon('gateway', process.execPath, [join(import.meta.dirname, 'gateway.mjs')], {
    E2E_FUNCTION_PORTS: JSON.stringify(functionPorts),
    ...(realStorage() ? { E2E_STORAGE_PORT: String(ports.storage) } : {}),
    E2E_TLS_PORT: String(ports.gatewayTls),
    E2E_TLS_CERT: localCertificate().cert,
    E2E_TLS_KEY: localCertificate().key,
  });
  if (realStorage()) {
    stopStorage();
  }
  await reset();
  const { anonKey, serviceKey } = await import('./seed.mjs');
  mkdirSync(join(root, 'tests/e2e-live/.stack'), { recursive: true });
  writeFileSync(join(root, 'tests/e2e-live/.stack/anon.key'), anonKey);
  writeFileSync(
    join(root, 'tests/e2e-live/.stack/storage.json'),
    JSON.stringify({ real: realStorage(), image: realStorage() ? storageApi.image : null }),
  );
  startFunctions(anonKey, serviceKey);
  // A successful spawn is not proof that Deno bound its port. Fail before the
  // browser suite if any function crashed (e.g. a stale listener or bad config).
  await Promise.all(
    Object.entries(functionPorts).map(async ([name, port]) => {
      try {
        await waitFor(`http://127.0.0.1:${port}/`);
      } catch {
        throw new Error(`E2E_EDGE_FUNCTION_UNAVAILABLE:${name}`);
      }
    }),
  );
  console.log(`E2E stack ready: gateway http://127.0.0.1:54321, database ${url(db)}`);
}

// A disposable P-256 key for offline authorization snapshots on this stack only: the private
// half goes to the Edge Function, the public half to the staff dev server (live config).
function offlineSigningKey() {
  const file = join(root, 'tests/e2e-live/.stack/offline-signing.jwk.json');
  if (!existsSync(file)) {
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    writeFileSync(file, JSON.stringify(privateKey.export({ format: 'jwk' })));
  }
  const jwk = JSON.parse(readFileSync(file, 'utf8'));
  writeFileSync(
    join(root, 'tests/e2e-live/.stack/offline-public.jwk.json'),
    JSON.stringify([{ kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y }]),
  );
  return JSON.stringify(jwk);
}

// Local CA plus a certificate for 127.0.0.1 signed by it, so the gateway can also be reached over
// HTTPS like a real project: the asset-upload function builds public URLs from it and trusts the
// CA (DENO_CERT); browsers in the specs accept it explicitly.
function localCertificate() {
  const ca = join(dir, 'tls-ca.pem'),
    cert = join(dir, 'tls-cert.pem'),
    key = join(dir, 'tls-key.pem');
  if (!existsSync(cert)) {
    const openssl = (...args) => execFileSync('openssl', args, { stdio: 'ignore' });
    const curve = ['-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes'];
    const caKey = join(dir, 'tls-ca-key.pem'),
      request = join(dir, 'tls.csr'),
      extensions = join(dir, 'tls.ext');
    openssl(
      'req',
      '-x509',
      ...curve,
      '-days',
      '3650',
      '-subj',
      '/CN=Plateform e2e CA',
      '-keyout',
      caKey,
      '-out',
      ca,
    );
    openssl('req', ...curve, '-subj', '/CN=127.0.0.1', '-keyout', key, '-out', request);
    writeFileSync(extensions, 'basicConstraints=CA:FALSE\nsubjectAltName=IP:127.0.0.1\n');
    openssl(
      'x509',
      '-req',
      '-in',
      request,
      '-CA',
      ca,
      '-CAkey',
      caKey,
      '-CAcreateserial',
      '-days',
      '3650',
      '-extfile',
      extensions,
      '-out',
      cert,
    );
  }
  return { ca, cert, key };
}

// Disposable worker secrets, new on every `up`: the functions get them as env, the specs read them
// from tests/e2e-live/.stack/workers.json (git-ignored), like the Vault secrets pg_net would send.
function workerSecrets() {
  const secrets = {
    messageWorkerToken: randomBytes(32).toString('hex'),
    noShowDepositWorkerToken: randomBytes(32).toString('hex'),
    databaseChaosProbeToken: randomBytes(32).toString('hex'),
  };
  writeFileSync(join(root, 'tests/e2e-live/.stack/workers.json'), JSON.stringify(secrets));
  return secrets;
}

function startFunctions(anonKey, serviceKey) {
  const signing = offlineSigningKey();
  const tls = localCertificate();
  const workers = workerSecrets();
  const archiveKeyId = `e2e-${randomBytes(4).toString('hex')}`,
    archiveKey = randomBytes(32).toString('base64');
  for (const [name, port] of Object.entries(functionPorts)) {
    stop(`fn-${name}`);
    daemon(
      `fn-${name}`,
      join(root, 'node_modules/deno/deno'),
      [
        'run',
        '--allow-env',
        '--allow-net',
        '--allow-read',
        '--config',
        join(root, 'supabase/functions/deno.json'),
        '--preload',
        join(import.meta.dirname, 'deno-serve-port.ts'),
        join(root, `supabase/functions/${name}/index.ts`),
      ],
      {
        DENO_DIR: join(root, '.local/deno'),
        FUNCTION_PORT: String(port),
        SUPABASE_URL:
          name === 'asset-upload'
            ? `https://127.0.0.1:${ports.gatewayTls}`
            : 'http://127.0.0.1:54321',
        DENO_CERT: tls.ca,
        SUPABASE_ANON_KEY: anonKey,
        SUPABASE_SERVICE_ROLE_KEY: serviceKey,
        OFFLINE_SIGNING_PRIVATE_JWK: signing,
        ENVIRONMENT: 'development',
        RELEASE_VERSION: '0.1.0',
        TELEMETRY_ENABLED: 'false',
        ALLOWED_ORIGINS: 'http://localhost:5173,http://localhost:5174',
        TRUSTED_CLIENT_IP_HEADER: 'x-forwarded-for',
        RATE_LIMIT_SECRET: randomBytes(32).toString('base64url'),
        MESSAGE_WORKER_TOKEN: workers.messageWorkerToken,
        NO_SHOW_DEPOSIT_WORKER_TOKEN: workers.noShowDepositWorkerToken,
        DATABASE_CHAOS_PROBE_TOKEN: workers.databaseChaosProbeToken,
        // Never contacts a provider; only the venue-configured MOCK adapter "sends".
        MESSAGE_DELIVERY_MODE: 'dry_run',
        PUBLIC_BASE_URL: 'https://localhost:5173',
        // No provider keys on this stack: a checkout start would fail closed before any call.
        DEPOSIT_RETURN_URL: 'https://localhost:5173/prenota',
        AUDIT_ARCHIVE_KEY_ID: archiveKeyId,
        AUDIT_ARCHIVE_ENCRYPTION_KEY: archiveKey,
      },
    );
  }
}

export function down() {
  for (const name of [
    'postgrest',
    'gotrue',
    'gateway',
    ...Object.keys(functionPorts).map((name) => `fn-${name}`),
  ])
    stop(name);
  if (realStorage()) stopStorage();
  try {
    run(join(pgBin, 'pg_ctl'), ['-D', join(dir, 'data'), '-m', 'fast', 'stop']);
  } catch {
    /* not running */
  }
}

const command = process.argv[2];
if (import.meta.url === `file://${process.argv[1]}`) {
  if (command === 'install') install();
  else if (command === 'up') await up();
  else if (command === 'reset') await reset();
  else if (command === 'down') down();
  else throw new Error('usage: stack.mjs install|up|reset|down');
}
