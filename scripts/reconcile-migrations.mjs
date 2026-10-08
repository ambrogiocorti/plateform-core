#!/usr/bin/env node
/**
 * Reconstruct the local migration inventory from the *actual* managed migration
 * history. Never invents migrations or reapplies them to an existing database.
 *
 * Usage:
 *   SUPABASE_DB_URL=... node scripts/reconcile-migrations.mjs --dry-run
 *   SUPABASE_DB_URL=... node scripts/reconcile-migrations.mjs --write
 *   node scripts/reconcile-migrations.mjs --input-file /path/export.jsonl --write
 *   node scripts/reconcile-migrations.mjs --input-file /path/export.jsonl --write \
 *     --adopt-remote-with-backup --expected-inventory-sha256 <verified-digest>
 *
 * Requires psql for direct retrieval, but no npm dependencies. The connection
 * string is kept in PGDATABASE (environment) rather than process arguments.
 */
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, writeFile, rename, rm, copyFile } from 'node:fs/promises';
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
const adopt = argv.has('--adopt-remote-with-backup');
if (adopt && !argv.has('--write')) throw new Error('Remote adoption requires --write.');
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
const remoteVersions = new Set();
for (const row of remote) {
  if (!/^\d{14}$/.test(row.version) || !/^[a-z0-9_]+$/.test(row.name) || typeof row.sql !== 'string')
    throw new Error('Invalid database migration metadata (refusing to write).');
  const file = filenameOf(row);
  if (remoteFiles.has(file) || remoteVersions.has(row.version))
    throw new Error('Duplicate migration version in database history.');
  remoteFiles.add(file);
  remoteVersions.add(row.version);
}
if (!remote.length) throw new Error('Database migration history was empty.');
const inventorySha256 = digest(remote
  .toSorted((a, b) => a.version.localeCompare(b.version))
  .map((row) => `${row.version}:${row.name}:${digest(row.sql)}`).join('\n'));
const expectedInventory = valueAfter('--expected-inventory-sha256');
if (expectedInventory && (!/^[a-f0-9]{64}$/.test(expectedInventory) ||
    inventorySha256 !== expectedInventory))
  throw new Error('REMOTE_MIGRATION_INVENTORY_FINGERPRINT_MISMATCH');
if (adopt && inputPath && !expectedInventory)
  throw new Error('Adopting an exported migration file requires an independently verified inventory fingerprint.');

const localFiles = (await readdir(migrationDir)).filter((f) => f.endsWith('.sql'));
const byVersion = new Map(remote.map((row) => [row.version, row]));
const divergences = [];
for (const filename of localFiles) {
  const match = /^(\d{14})_([a-z0-9_]+)\.sql$/.exec(filename);
  if (!match) throw new Error(`Unexpected local migration file: ${filename}`);
  const row = byVersion.get(match[1]);
  if (!row || row.name !== match[2]) {
    divergences.push({ filename, reason: 'MISSING_OR_RENAMED_REMOTE_VERSION' });
    continue;
  }
  const existing = await readFile(join(migrationDir, filename));
  const localSha = digest(existing), remoteSha = digest(row.sql);
  if (localSha !== remoteSha) {
    divergences.push({ filename, reason: 'SQL_SHA256_MISMATCH',
      local_sha256: localSha, remote_sha256: remoteSha });
  }
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
console.log(JSON.stringify({ state: divergences.length ? 'DIVERGENT' : missing.length ? 'INCOMPLETE' : 'SYNCED',
  local: localFiles.length, database: remote.length, missing: missing.length,
  inventory_sha256: inventorySha256,
  missing_first: missing[0]?.version ?? null, missing_last: missing.at(-1)?.version ?? null,
  mismatches: divergences, mismatch_count: divergences.length,
  mode: argv.has('--write') ? 'write' : 'dry-run' }, null, 2));
if (divergences.length && (!argv.has('--write') || !adopt)) {
  if (argv.has('--write')) throw new Error('Local and remote SQL differ: refusing destructive reconciliation. Use --adopt-remote-with-backup only with verified SQL history.');
  process.exitCode = 2;
} else if (argv.has('--dry-run')) {
  if (missing.length) process.exitCode = 2;
}
else if (divergences.length && adopt) {
  // Remote SQL is the canonical applied history; keep the *entire* prior local
  // migration tree and manifest before adopting it. Never rewrite DB history.
  if (remote.length < localFiles.length ||
      divergences.some((entry) => entry.reason !== 'SQL_SHA256_MISMATCH'))
    throw new Error('REMOTE_HISTORY_INCOMPLETE: at least one local migration has no remote counterpart.');
  const supabase = join(repo, 'supabase');
  const backupRoot = join(supabase, 'migration-recovery-backups',
    `${new Date().toISOString().replaceAll(/[:.]/g,'-')}-${randomUUID()}`);
  const staged = await mkdtemp(join(supabase, '.migration-recovery-staging-'));
  const stagedMigrations = join(staged, 'migrations');
  await mkdir(stagedMigrations, {mode: 0o700});
  let movedOld = false;
  let movedNew = false;
  try {
    const manifest = { ...current, migrations: remote.map((row) => ({
      filename: filenameOf(row), version: row.version, name: row.name, sha256: digest(row.sql),
    })) };
    for (const row of remote) {
      const filename = filenameOf(row);
      const destination = join(stagedMigrations, filename);
      await writeFile(destination, row.sql, { flag: 'wx', mode: 0o600 });
      if (digest(await readFile(destination)) !== digest(row.sql))
        throw new Error(`Cannot verify canonical migration: ${filename}`);
    }
    await writeFile(join(staged, 'migration-manifest.json'),
      JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
    await mkdir(backupRoot, { recursive: true, mode: 0o700 });
    await copyFile(manifestPath, join(backupRoot, 'migration-manifest.json'));
    await writeFile(join(backupRoot, 'adoption-report.json'), JSON.stringify({
      adopted_at: new Date().toISOString(), remote_inventory_sha256: inventorySha256,
      prior_local_count: localFiles.length, remote_count: remote.length,
      divergences, missing: missing.map(filenameOf),
    }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    await rename(migrationDir, join(backupRoot, 'migrations'));
    movedOld = true;
    await rename(stagedMigrations, migrationDir);
    movedNew = true;
    await rename(join(staged, 'migration-manifest.json'), manifestPath);
    console.log(`ADOPTED_REMOTE_HISTORY=${remote.length}; PREVIOUS_SOURCE_PRESERVED=${backupRoot}`);
  } catch (error) {
    // Roll back to the old manifest and migration tree on a partial swap.
    if (movedNew) await rename(migrationDir, stagedMigrations);
    if (movedOld) await rename(join(backupRoot, 'migrations'), migrationDir);
    throw error;
  } finally { await rm(staged, {recursive:true,force:true}); }
}
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
