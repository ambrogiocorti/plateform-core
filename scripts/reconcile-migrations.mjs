#!/usr/bin/env node
/**
 * Reconstruct the local migration inventory from the *actual* managed migration
 * history. Never invents migrations or reapplies them to an existing database.
 *
 * Usage:
 *   SUPABASE_DB_URL=... node scripts/reconcile-migrations.mjs --dry-run
 *   SUPABASE_DB_URL=... node scripts/reconcile-migrations.mjs --write
 *   node scripts/reconcile-migrations.mjs --input-file /path/export.jsonl --write
 *
 * Requires psql for direct retrieval, but no npm dependencies. The connection
 * string is kept in PGDATABASE (environment) rather than process arguments.
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, writeFile, rename, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';

const argv = new Set(process.argv.slice(2));
const valueAfter = (key) => {
  const index = process.argv.indexOf(key);
  return index < 0 ? null : process.argv[index + 1];
};
if (argv.has('--write') === argv.has('--dry-run')) {
  throw new Error('Specify exactly one of --write or --dry-run.');
}
const repo = resolve(process.env.PLATEFORM_REPO_ROOT || '.');
const migrationDir = join(repo, 'supabase/migrations');
const manifestPath = join(repo, 'supabase/migration-manifest.json');
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

const query = `SELECT row_to_json(m)::text FROM (
 SELECT version, name, array_to_string(statements,E'\\n') AS sql
 FROM supabase_migrations.schema_migrations
) m ORDER BY (m.version);`;

let lines;
const inputPath = valueAfter('--input-file');
if (inputPath) {
  lines = (await readFile(inputPath, 'utf8')).trim().split(/\r?\n/);
} else {
  const conn = process.env.SUPABASE_DB_URL;
  if (!conn || !/^postgres(?:ql)?:\/\//.test(conn))
    throw new Error('SUPABASE_DB_URL must be configured with a PostgreSQL URL.');
  const run = spawnSync(process.env.PSQL_BIN || 'psql',
    ['-X', '--no-align', '--tuples-only', '--set', 'ON_ERROR_STOP=1', '--command', query], {
      env: { ...process.env, PGDATABASE: conn, PGCONNECT_TIMEOUT: '15' },
      encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 60000,
    });
  if (run.error || run.status !== 0)
    throw new Error('Migration history query failed. Verify private DB access and the psql client.');
  lines = run.stdout.trim().split(/\r?\n/);
}
const remote = lines.filter(Boolean).map((line) => JSON.parse(line));
const filenameOf = (row) => `${row.version}_${row.name}.sql`;
const remoteFiles = new Set();
for (const row of remote) {
  if (!/^\d{14}$/.test(row.version) || !/^[a-z0-9_]+$/.test(row.name) || typeof row.sql !== 'string')
    throw new Error('Invalid database migration metadata (refusing to write).');
  const file = filenameOf(row);
  if (remoteFiles.has(file)) throw new Error('Duplicate migration in database history.');
  remoteFiles.add(file);
}
if (!remote.length) throw new Error('Database migration history was empty.');

const localFiles = (await readdir(migrationDir)).filter((f) => f.endsWith('.sql'));
const byVersion = new Map(remote.map((row) => [row.version, row]));
for (const filename of localFiles) {
  const match = /^(\d{14})_([a-z0-9_]+)\.sql$/.exec(filename);
  if (!match) throw new Error(`Unexpected local migration file: ${filename}`);
  const row = byVersion.get(match[1]);
  if (!row || row.name !== match[2]) throw new Error(`Local migration is absent or renamed in remote history: ${filename}`);
  const existing = await readFile(join(migrationDir, filename));
  if (digest(existing) !== digest(row.sql))
    throw new Error(`Local and remote SQL differ for ${filename}: refusing destructive reconciliation.`);
}
const current = JSON.parse(await readFile(manifestPath, 'utf8'));
if (!Array.isArray(current.migrations) || current.migrations.length !== localFiles.length)
  throw new Error('Local manifest does not describe the local migration files.');
for (const item of current.migrations) {
  if (!localFiles.includes(item.filename) ||
      digest(await readFile(join(migrationDir, item.filename))) !== item.sha256)
    throw new Error(`Local manifest is invalid: ${item.filename}`);
}

const missing = remote.filter((row) => !localFiles.includes(filenameOf(row)));
console.log(JSON.stringify({ state: missing.length ? 'INCOMPLETE' : 'SYNCED',
  local: localFiles.length, database: remote.length, missing: missing.length,
  missing_first: missing[0]?.version ?? null, missing_last: missing.at(-1)?.version ?? null,
  mode: argv.has('--write') ? 'write' : 'dry-run' }, null, 2));
if (argv.has('--dry-run')) { if (missing.length) process.exitCode = 2; }
else {
  // Prepare the full inventory before any write. Do not modify old migration SQL.
  const manifest = { ...current, migrations: remote.map((row) => ({
    filename: filenameOf(row), version: row.version, name: row.name, sha256: digest(row.sql),
  })) };
  const scratch = await mkdtemp(join(tmpdir(), 'plateform-migration-recovery-'));
  try {
    for (const row of missing) {
      const filename = filenameOf(row);
      await writeFile(join(scratch, filename), row.sql, { flag: 'wx', mode: 0o600 });
      if (digest(await readFile(join(scratch, filename))) !== digest(row.sql))
        throw new Error(`Cannot verify staged file: ${filename}`);
    }
    await writeFile(join(scratch, 'migration-manifest.json'),
      JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
    for (const row of missing) await rename(join(scratch, filenameOf(row)), join(migrationDir, filenameOf(row)));
    await rename(join(scratch, 'migration-manifest.json'), manifestPath);
    console.log(`RECOVERED_MIGRATIONS=${missing.length}; VERIFIED_TOTAL=${remote.length}`);
  } finally { await rm(scratch, { force: true, recursive: true }); }
}
