// Disposable PostgreSQL cluster for the local disaster-recovery rehearsal.
// It listens ONLY on a private Unix socket (listen_addresses='') inside a fresh
// temporary directory, so no shared, linked, staging or production database can
// ever be reached through it. Everything is deleted on stop().
import { spawn } from 'node:child_process';
import { chmod, chown, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function run(command, args, { input, env, allowFailure = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...safeEnv(), ...(env ?? {}) },
    });
    let stdout = '',
      stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0 || allowFailure) return resolve({ code, stdout, stderr });
      reject(new Error(`COMMAND_FAILED:${command}:${code}:${stderr.slice(0, 800)}`));
    });
    child.stdin.end(input ?? '');
  });
}

// Never inherit connection settings that could point libpq at a real database.
export function safeEnv() {
  const env = { ...process.env };
  for (const name of [
    'PGHOST',
    'PGHOSTADDR',
    'PGPORT',
    'PGSERVICE',
    'PGDATABASE',
    'PGUSER',
    'PGPASSWORD',
    'PGPASSFILE',
    'DATABASE_URL',
    'SUPABASE_DB_URL',
    'SUPABASE_URL',
    'SUPABASE_SERVICE_ROLE_KEY',
  ])
    delete env[name];
  return env;
}

async function pgBinDir() {
  if (process.env.PLATEFORM_PG_BIN) return process.env.PLATEFORM_PG_BIN;
  const { stdout } = await run('pg_config', ['--bindir']);
  return stdout.trim();
}

export async function startCluster({ port = 55432 + Math.floor(Math.random() * 1000) } = {}) {
  const bin = await pgBinDir();
  const { stdout: version } = await run(join(bin, 'postgres'), ['--version']);
  const major = Number(version.match(/(\d+)\.\d+/)?.[1]);
  if (major !== 16) throw new Error(`LOCAL_PG_16_REQUIRED:${version.trim()}`);
  // Short path: Unix socket paths are limited to 107 bytes.
  const base = await mkdtemp(join(tmpdir().length > 40 ? '/tmp' : tmpdir(), 'pfdr-'));
  await chmod(base, 0o700);
  const data = join(base, 'data');
  const asRoot = process.getuid?.() === 0;
  const owner = asRoot ? await run('id', ['-u', 'postgres']).catch(() => null) : null;
  if (asRoot && !owner) throw new Error('LOCAL_PG_NON_ROOT_USER_REQUIRED');
  if (asRoot) {
    const uid = Number(owner.stdout.trim());
    const { stdout: gid } = await run('id', ['-g', 'postgres']);
    await chown(base, uid, Number(gid.trim()));
  }
  const pgRun = (exe, args) =>
    asRoot
      ? run('runuser', ['-u', 'postgres', '--', join(bin, exe), ...args])
      : run(join(bin, exe), args);
  await pgRun('initdb', ['-D', data, '-U', 'postgres', '--auth=trust', '-E', 'UTF8', '--no-sync']);
  await pgRun('pg_ctl', [
    '-D',
    data,
    '-w',
    '-l',
    join(base, 'postgres.log'),
    '-o',
    `-k ${base} -p ${port} -c listen_addresses='' -c fsync=off`,
    'start',
  ]);
  const cluster = {
    bin,
    socket: base,
    port,
    major,
    url: (db) =>
      `postgresql://postgres@localhost/${db}?host=${encodeURIComponent(base)}&port=${port}`,
    psql: (db, sql, opts = {}) =>
      run(
        join(bin, 'psql'),
        ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-d', cluster.url(db)],
        { input: sql, ...opts },
      ),
    async stop() {
      await pgRun('pg_ctl', ['-D', data, '-m', 'immediate', 'stop']).catch(() => undefined);
      await rm(base, { recursive: true, force: true });
    },
  };
  // Supabase gives the postgres role this search_path; worker SQL relies on it
  // for unqualified pgcrypto calls such as digest().
  await cluster.psql(
    'postgres',
    `alter role postgres set search_path to "$user", public, extensions`,
  );
  return cluster;
}
