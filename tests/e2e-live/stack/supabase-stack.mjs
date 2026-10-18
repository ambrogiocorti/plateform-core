// Full local Supabase stack for the live browser suite, via the Supabase CLI (Docker):
// PostgreSQL 17, GoTrue, PostgREST, Realtime, Storage and Kong exactly as `supabase start` runs
// them, plus the repository's Edge Functions served by the host Deno behind edge-gateway.mjs.
// Commands: up | reset | down. Local and disposable only: it never targets a linked project.
//
// Sandbox notes (applied only when E2E_IMAGE_MIRROR is set, e.g. mirror.gcr.io):
// - images are pulled from the mirror and tagged with the names the CLI expects;
// - Realtime is rebuilt locally to listen on IPv4 when the kernel has no IPv6.
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const root = resolve(import.meta.dirname, '../../..');
const stateDir = join(root, 'tests/e2e-live/.stack');
const logDir = process.env.E2E_STACK_DIR ?? '/tmp/plateform-e2e';
const mirror = process.env.E2E_IMAGE_MIRROR ?? '';
const project = 'plateform-development';
const template = 'plateform_e2e_template';
const gatewayPort = 54320;
// Kong is restarted too: it caches the upstream container addresses, which change on restart.
const services = ['auth', 'rest', 'realtime', 'storage', 'pg_meta', 'kong'].map(
  (name) => `supabase_${name}_${project}`,
);
// Edge Functions exercised by the suite, one local port each.
export const functionPorts = {
  'step-up': 54401,
  'staff-admin': 54402,
  payments: 54403,
  'health-probe': 54404,
};
const images = [
  ['supabase/postgres:17.6.1.029', 'supabase/postgres:17.6.1.029'],
  ['library/kong:2.8.1', 'supabase/kong:2.8.1'],
  ['postgrest/postgrest:v13.0.7', 'supabase/postgrest:v13.0.7'],
  ['supabase/gotrue:v2.180.0', 'supabase/gotrue:v2.180.0'],
  ['supabase/realtime:v2.57.3', 'supabase/realtime:v2.57.3'],
  ['supabase/storage-api:v1.28.2', 'supabase/storage-api:v1.28.2'],
  ['supabase/postgres-meta:v0.93.1', 'supabase/postgres-meta:v0.93.1'],
];

const supabaseEnv = () => ({
  ...process.env,
  ...(mirror ? { SUPABASE_INTERNAL_IMAGE_REGISTRY: mirror } : {}),
});
const sh = (file, args, options = {}) =>
  execFileSync(file, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options });

function prepareImages() {
  if (!mirror) return;
  for (const [source, name] of images) {
    const tagged = `${mirror}/${name}`;
    try {
      sh('docker', ['image', 'inspect', tagged]);
      continue;
    } catch {
      /* not present yet */
    }
    sh('docker', ['pull', '-q', `${mirror}/${source}`], { stdio: 'inherit' });
    if (source !== name) sh('docker', ['tag', `${mirror}/${source}`, tagged]);
    if (name.startsWith('supabase/realtime:')) {
      const context = join(logDir, 'realtime-ipv4');
      mkdirSync(context, { recursive: true });
      writeFileSync(
        join(context, 'Dockerfile'),
        `FROM ${tagged}\nRUN sed -i 's/socket_opts: \\[:inet6\\]/socket_opts: [:inet]/' /app/releases/*/runtime.exs\n`,
      );
      sh('docker', ['build', '-q', '-t', tagged, context]);
    }
  }
}

function status() {
  const env = Object.fromEntries(
    sh('supabase', ['status', '-o', 'env'], { cwd: root, env: supabaseEnv() })
      .split('\n')
      .map((line) => /^([A-Z_]+)="?(.*?)"?$/.exec(line.trim()))
      .filter(Boolean)
      .map((match) => [match[1], match[2]]),
  );
  return {
    mode: 'supabase',
    supabaseUrl: `http://127.0.0.1:${gatewayPort}`,
    kongUrl: env.API_URL,
    dbUrl: env.DB_URL,
    anonKey: env.ANON_KEY,
    serviceKey: env.SERVICE_ROLE_KEY,
    jwtSecret: env.JWT_SECRET,
  };
}

// Database cloning needs the platform superuser (the CLI's `postgres` role is not one).
const admin = (sql) =>
  sh('docker', [
    'exec',
    '-e',
    'PGPASSWORD=postgres',
    `supabase_db_${project}`,
    'psql',
    '-U',
    'supabase_admin',
    '-d',
    'template1',
    '-X',
    '-q',
    '-At',
    '-v',
    'ON_ERROR_STOP=1',
    '-c',
    sql,
  ]).trim();

function daemon(name, command, args, env) {
  mkdirSync(logDir, { recursive: true });
  const log = join(logDir, `${name}.log`);
  const child = spawn('sh', ['-c', `exec "$0" "$@" >>"${log}" 2>&1`, command, ...args], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, ...env },
  });
  child.unref();
}

function release(port) {
  try {
    sh('fuser', ['-s', '-k', '-TERM', `${port}/tcp`]);
  } catch {
    /* free */
  }
}

async function waitFor(address, accept = (code) => code < 500, headers = {}) {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    try {
      if (accept((await fetch(address, { headers })).status)) return;
    } catch {
      /* not ready yet */
    }
    await sleep(200);
  }
  throw new Error(`Timeout waiting for ${address}`);
}

function startEdge(state) {
  const deno = join(root, 'node_modules/deno/bin.cjs');
  for (const [name, port] of Object.entries(functionPorts)) {
    release(port);
    daemon(
      `fn-${name}`,
      process.execPath,
      [
        deno,
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
        SUPABASE_URL: state.kongUrl,
        SUPABASE_ANON_KEY: state.anonKey,
        SUPABASE_SERVICE_ROLE_KEY: state.serviceKey,
        ENVIRONMENT: 'development',
        RELEASE_VERSION: '0.1.0',
        TELEMETRY_ENABLED: 'false',
        ALLOWED_ORIGINS: 'http://localhost:5173,http://localhost:5174',
        TRUSTED_CLIENT_IP_HEADER: 'x-forwarded-for',
        RATE_LIMIT_SECRET: randomBytes(32).toString('base64url'),
      },
    );
  }
  release(gatewayPort);
  daemon('edge-gateway', process.execPath, [join(import.meta.dirname, 'edge-gateway.mjs')], {
    E2E_GATEWAY_PORT: String(gatewayPort),
    E2E_KONG_PORT: new URL(state.kongUrl).port,
    E2E_FUNCTION_PORTS: JSON.stringify(functionPorts),
  });
}

async function waitServices(state) {
  const headers = { apikey: state.anonKey };
  await waitFor(`${state.kongUrl}/auth/v1/health`, (code) => code === 200, headers);
  await waitFor(`${state.kongUrl}/rest/v1/`, (code) => code < 500, headers);
}

export async function reset() {
  const state = JSON.parse(readFileSync(join(stateDir, 'env.json'), 'utf8'));
  sh('docker', ['stop', '-t', '2', ...services]);
  // Dropping the database pg_cron runs in can crash its worker, and the postmaster then restarts
  // every backend (including ours): retry until the fresh copy exists.
  for (let attempt = 0; ; attempt += 1) {
    try {
      admin('drop database if exists postgres with (force)');
      admin(`create database postgres template ${template}`);
      break;
    } catch (error) {
      if (attempt >= 10) throw error;
      await sleep(1000);
    }
  }
  sh('docker', ['start', ...services]);
  await waitServices(state);
  // Realtime (re)connects to the recreated database before it can deliver changes.
  await sleep(3000);
}

export async function up() {
  prepareImages();
  sh(
    'supabase',
    ['start', '-x', 'studio,imgproxy,logflare,vector,supavisor,mailpit,edge-runtime'],
    { cwd: root, env: supabaseEnv(), stdio: 'inherit' },
  );
  const state = status();
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, 'env.json'), JSON.stringify(state, null, 2));
  writeFileSync(join(stateDir, 'anon.key'), state.anonKey);
  const hasTemplate = admin(`select 1 from pg_database where datname='${template}'`);
  if (!hasTemplate) {
    Object.assign(process.env, {
      E2E_SUPABASE_URL: state.kongUrl,
      E2E_DB_URL: state.dbUrl,
      E2E_ANON_KEY: state.anonKey,
      E2E_SERVICE_KEY: state.serviceKey,
    });
    const { seed } = await import('./seed.mjs');
    await seed();
    sh('docker', ['stop', '-t', '2', ...services]);
    // pg_cron's launcher reconnects on its own: block connections while cloning.
    admin('alter database postgres allow_connections false');
    admin(`select pg_terminate_backend(pid) from pg_stat_activity where datname='postgres'`);
    admin(`create database ${template} template postgres allow_connections false`);
    admin('alter database postgres allow_connections true');
    sh('docker', ['start', ...services]);
    await waitServices(state);
  }
  startEdge(state);
  await waitFor(`http://127.0.0.1:${gatewayPort}/auth/v1/health`, (code) => code === 200, {
    apikey: state.anonKey,
  });
  for (const port of Object.values(functionPorts))
    await waitFor(`http://127.0.0.1:${port}/`, () => true);
  console.log(`Supabase e2e stack ready: ${state.supabaseUrl} (Kong ${state.kongUrl})`);
}

export function down() {
  for (const port of [gatewayPort, ...Object.values(functionPorts)]) release(port);
  if (existsSync(join(stateDir, 'env.json')))
    sh('supabase', ['stop', '--no-backup'], { cwd: root, env: supabaseEnv(), stdio: 'inherit' });
}

const command = process.argv[2];
if (import.meta.url === `file://${process.argv[1]}`) {
  if (command === 'up') await up();
  else if (command === 'reset') await reset();
  else if (command === 'down') down();
  else throw new Error('usage: supabase-stack.mjs up|reset|down');
}
