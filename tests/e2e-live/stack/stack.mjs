// Disposable local stack for the live browser suite (no Docker required):
//   PostgreSQL 16+ (local binaries) + GoTrue (supabase/auth) + PostgREST + a tiny gateway.
// Commands: install | up | reset | down. Data lives under E2E_STACK_DIR (default /tmp/plateform-e2e)
// and is recreated from a template database on every `reset`. It never targets remote databases.
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
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
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      if ((await fetch(address)).status < 500) return;
    } catch {
      /* not ready yet */
    }
    await sleep(200);
  }
  throw new Error(`Timeout waiting for ${address}`);
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

const ports = { gateway: 54321, postgrest: 54330, gotrue: 9999 };

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

// The template is rebuilt whenever migrations, bootstrap or seed change.
function fingerprint() {
  const hash = createHash('sha256');
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
  const roles = readFileSync(join(import.meta.dirname, 'bootstrap.sql'), 'utf8');
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
  daemon('gotrue', join(bin, 'auth'), [], gotrueEnv(db));
  daemon('postgrest', join(bin, 'postgrest'), [postgrestConfig(db)]);
  await waitFor('http://127.0.0.1:9999/health');
  await waitFor('http://127.0.0.1:54330/');
}

export async function up() {
  install();
  startPostgres();
  await buildTemplate();
  stop('gateway');
  daemon('gateway', process.execPath, [join(import.meta.dirname, 'gateway.mjs')]);
  await reset();
  const { anonKey } = await import('./seed.mjs');
  mkdirSync(join(root, 'tests/e2e-live/.stack'), { recursive: true });
  writeFileSync(join(root, 'tests/e2e-live/.stack/anon.key'), anonKey);
  console.log(`E2E stack ready: gateway http://127.0.0.1:54321, database ${url(db)}`);
}

export function down() {
  for (const name of ['postgrest', 'gotrue', 'gateway']) stop(name);
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
