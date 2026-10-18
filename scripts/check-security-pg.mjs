#!/usr/bin/env node
// Security probe on a disposable local PostgreSQL 16 database.
// Replays the full migration chain on top of the Supabase platform fixture,
// then runs every supabase/tests/security/[1-9]*.sql probe as the API roles.
// Each probe raises an exception on the first violated expectation.
// Usage: PG_SECURITY_URL=postgres://postgres@localhost:5432/postgres node scripts/check-security-pg.mjs [--keep]
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const admin = process.env.PG_SECURITY_URL ?? 'postgres://postgres@localhost:5432/postgres';
const url = new URL(admin);
if (!['localhost', '127.0.0.1', '::1', ''].includes(url.hostname)) {
  console.error('REFUSED: security probe only runs against a local PostgreSQL server.');
  process.exit(2);
}
const keep = process.argv.includes('--keep');
const only = process.argv.find((arg) => arg.startsWith('--only='))?.slice(7);
const database = `plateform_security_${process.pid}`;
const target = new URL(admin);
target.pathname = `/${database}`;
const work = mkdtempSync(join(tmpdir(), 'plateform-security-'));

function psql(connection, args, input) {
  const result = spawnSync('psql', [connection, '-X', '-q', '-v', 'ON_ERROR_STOP=1', ...args], {
    input,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return result;
}

function run(connection, file, label, single = true) {
  // Probes manage their own BEGIN ... ROLLBACK; migrations run in one transaction.
  const result = psql(connection, [...(single ? ['--single-transaction'] : []), '-f', file]);
  if (result.status !== 0) {
    console.error(`FAIL ${label}\n${result.stderr.trim()}`);
    return false;
  }
  return true;
}

let created = false;
let failed = 0;
try {
  const create = psql(admin, ['-c', `create database ${database}`]);
  if (create.status !== 0) throw new Error(create.stderr);
  created = true;
  if (
    !run(
      target.href,
      'supabase/tests/security/00_supabase_platform_fixture.sql',
      'platform fixture',
    )
  )
    throw new Error('fixture failed');
  const migrations = readdirSync('supabase/migrations')
    .filter((name) => name.endsWith('.sql'))
    .sort();
  for (const name of migrations) {
    const sql = readFileSync(`supabase/migrations/${name}`, 'utf8').replace(
      /^create extension if not exists pg_cron;\s*$/gim,
      '',
    );
    const file = join(work, name);
    writeFileSync(file, sql);
    if (!run(target.href, file, `migration ${name}`)) throw new Error(`migration ${name} failed`);
  }
  console.log(`OK replayed ${migrations.length} migrations on ${database}`);
  const probes = readdirSync('supabase/tests/security')
    .filter((name) => /^[1-9].*\.sql$/.test(name) && (!only || name.includes(only)))
    .sort();
  for (const name of probes) {
    if (run(target.href, `supabase/tests/security/${name}`, `probe ${name}`, false))
      console.log(`PASS ${name}`);
    else failed += 1;
  }
  console.log(`${probes.length - failed}/${probes.length} security probes passed`);
} catch (error) {
  console.error(String(error?.message ?? error));
  failed += 1;
} finally {
  if (created && !keep) psql(admin, ['-c', `drop database ${database} with (force)`]);
  if (keep && created) console.log(`kept ${target.href}`);
}
process.exit(failed ? 1 : 0);
