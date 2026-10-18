#!/usr/bin/env node
// Local replacement for `supabase db dump` used ONLY by the disaster-recovery
// rehearsal. It maps the flags used by tools/backup-worker/dump.mjs onto
// pg_dump/pg_dumpall 16 with the managed-schema exclusions of the Supabase CLI,
// so the backup worker can run unchanged against a disposable local cluster.
// Refuses any database URL that is not a local Unix socket.
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const MANAGED = [
  'information_schema',
  'pg_*',
  '_analytics',
  '_realtime',
  '_supavisor',
  'auth',
  'extensions',
  'pgbouncer',
  'realtime',
  'storage',
  'supabase_functions',
  'supabase_migrations',
  'cron',
  'graphql',
  'graphql_public',
  'net',
  'pgsodium',
  'pgsodium_masks',
  'vault',
];
// Data dumps keep Auth and Storage metadata (documented Supabase behaviour).
const DATA_EXCLUDED = MANAGED.filter((s) => !['auth', 'storage'].includes(s));
const RESERVED_ROLE =
  /^(postgres|anon|authenticated|service_role|authenticator|pgbouncer|dashboard_user|supabase_\w+|pg_\w+)$/;

const args = process.argv.slice(2);
if (args[0] === '--version') {
  console.log('local-dr-rehearsal (pg_dump 16 shim)');
  process.exit(0);
}
if (args[0] !== 'db' || args[1] !== 'dump') {
  console.error('UNSUPPORTED_COMMAND');
  process.exit(2);
}
if (args.includes('--help')) {
  console.log(
    'db dump --db-url URL -f FILE [--role-only|--data-only --use-copy|--schema S] [-x T]',
  );
  process.exit(0);
}

const value = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};
const dbUrl = value('--db-url');
const file = value('-f');
const url = new URL(dbUrl ?? 'invalid://');
if (
  !['postgres:', 'postgresql:'].includes(url.protocol) ||
  !url.searchParams.get('host')?.startsWith('/')
) {
  console.error('LOCAL_SOCKET_DATABASE_REQUIRED');
  process.exit(2);
}
const excludedTables = args.flatMap((a, i) => (a === '-x' ? [args[i + 1]] : []));
const bin = process.env.PLATEFORM_PG_BIN ?? '';

function exec(command, argv) {
  return new Promise((resolve, reject) => {
    const child = spawn(join(bin, command), argv, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '',
      err = '';
    child.stdout.on('data', (c) => (out += c));
    child.stderr.on('data', (c) => (err += c));
    child.once('error', reject);
    child.once('exit', (code) =>
      code === 0 ? resolve(out) : reject(new Error(err.slice(0, 600))),
    );
  });
}

try {
  if (args.includes('--role-only')) {
    const dump = await exec('pg_dumpall', ['--roles-only', '--no-role-passwords', '-d', dbUrl]);
    const kept = dump
      .split('\n')
      .filter((line) => {
        const role = line.match(/^(?:CREATE|ALTER) ROLE (\S+?)[ ;]/)?.[1]?.replaceAll('"', '');
        const grant = line.match(/^GRANT (\S+) TO (\S+?)[ ;]/);
        if (role) return !RESERVED_ROLE.test(role);
        if (grant)
          return ![grant[1], grant[2]].some((r) => RESERVED_ROLE.test(r.replaceAll('"', '')));
        return true;
      })
      .join('\n');
    await writeFile(file, `${kept}\n-- local-dr-rehearsal roles\n`, { mode: 0o600 });
  } else {
    const schemaOnly = value('--schema');
    const dataOnly = args.includes('--data-only');
    const argv = ['-d', dbUrl, '-f', file, '--quote-all-identifiers'];
    if (schemaOnly) argv.push('--schema', schemaOnly);
    else for (const s of dataOnly ? DATA_EXCLUDED : MANAGED) argv.push('--exclude-schema', s);
    for (const t of excludedTables) argv.push('--exclude-table', t);
    argv.push(dataOnly ? '--data-only' : '--schema-only');
    await exec('pg_dump', argv);
    if (!dataOnly) {
      // Like the Supabase CLI, never emit CREATE for the pre-existing schema.
      const text = await readFile(file, 'utf8');
      await writeFile(file, text.replace(/^CREATE SCHEMA "?public"?;$/m, ''), { mode: 0o600 });
    }
  }
} catch (error) {
  console.error(`DUMP_FAILED:${error.message}`);
  process.exit(1);
}
