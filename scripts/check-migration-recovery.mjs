import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = await mkdtemp(join(tmpdir(), 'plateform-migration-recovery-test-'));
const source = resolve('scripts/reconcile-migrations.mjs');
const migrate = join(root, 'supabase/migrations');
let count = 0;
const sha = (value) => createHash('sha256').update(value).digest('hex');
const old = { version: '20261003165439', name: 'foundation', sql: 'CREATE TABLE legacy (id int);\n' };
const next = { version: '20261006150000', name: 'new_public_site', sql: 'CREATE TABLE new_public_site (id int);\n' };
const oldName = `${old.version}_${old.name}.sql`;
const nextName = `${next.version}_${next.name}.sql`;
const remoteFile = join(root, 'remote.jsonl');
const run = (args, file = remoteFile) => spawnSync(process.execPath,
  [source, ...args, '--input-file', file],
  { cwd: root, env: { ...process.env, PLATEFORM_REPO_ROOT: root }, encoding: 'utf8', timeout: 20000 });
try {
  await mkdir(migrate, { recursive: true });
  await writeFile(join(migrate, oldName), old.sql);
  await writeFile(join(root, 'supabase/migration-manifest.json'),
    JSON.stringify({ migrations: [{ filename: oldName, version: old.version, name: old.name, sha256: sha(old.sql) }] }));
  await writeFile(remoteFile, [old, next].map((row) => JSON.stringify(row)).join('\n'));
  const pending = run(['--dry-run']);
  assert.equal(pending.status, 2, pending.stderr); count++;
  assert.match(pending.stdout, /"missing": 1/); count++;
  assert.deepEqual((await readdir(migrate)), [oldName]); count++;
  const unsafe = { ...old, sql: 'DROP TABLE legacy;' };
  const modified = join(root, 'modified.jsonl');
  await writeFile(modified, [unsafe, next].map((row) => JSON.stringify(row)).join('\n'));
  const rejected = run(['--write'], modified);
  assert.notEqual(rejected.status, 0); count++;
  assert.match(rejected.stderr, /remote SQL differ/); count++;
  assert.deepEqual((await readdir(migrate)), [oldName]); count++;
  const committed = run(['--write']);
  assert.equal(committed.status, 0, committed.stderr); count++;
  assert.equal(await readFile(join(migrate, nextName), 'utf8'), next.sql); count++;
  const manifest = JSON.parse(await readFile(join(root, 'supabase/migration-manifest.json'), 'utf8'));
  assert.equal(manifest.migrations.length, 2); count++;
  assert.equal(manifest.migrations[1].sha256, sha(next.sql)); count++;
  const verified = run(['--dry-run']);
  assert.equal(verified.status, 0, verified.stderr); count++;
  assert.match(verified.stdout, /"missing": 0/); count++;

  // A divergent applied migration may only be adopted from an independently
  // fingerprinted export, and the original local history must be recoverable.
  const remoteFingerprint = sha([unsafe, next].map((row) =>
    `${row.version}:${row.name}:${sha(row.sql)}`).join('\n'));
  const badFingerprint = run(['--write', '--adopt-remote-with-backup',
    '--expected-inventory-sha256', '0'.repeat(64)], modified);
  assert.notEqual(badFingerprint.status, 0); count++;
  assert.match(badFingerprint.stderr, /REMOTE_MIGRATION_INVENTORY_FINGERPRINT_MISMATCH/); count++;
  assert.equal(await readFile(join(migrate, oldName), 'utf8'), old.sql); count++;

  const adopted = run(['--write', '--adopt-remote-with-backup',
    '--expected-inventory-sha256', remoteFingerprint], modified);
  assert.equal(adopted.status, 0, adopted.stderr); count++;
  assert.equal(await readFile(join(migrate, oldName), 'utf8'), unsafe.sql); count++;
  const archives = await readdir(join(root, 'supabase/migration-recovery-backups'));
  assert.equal(archives.length, 1); count++;
  const backup = join(root, 'supabase/migration-recovery-backups', archives[0]);
  assert.equal(await readFile(join(backup, 'migrations', oldName), 'utf8'), old.sql); count++;
  const originalManifest = JSON.parse(await readFile(join(backup, 'migration-manifest.json'),'utf8'));
  assert.equal(originalManifest.migrations.length, 2); count++;
  assert.equal(originalManifest.migrations[0].sha256, sha(old.sql)); count++;
  const report = JSON.parse(await readFile(join(backup, 'adoption-report.json'),'utf8'));
  assert.equal(report.remote_inventory_sha256, remoteFingerprint); count++;
  assert.equal(report.divergences.length, 1); count++;
  assert.equal(run(['--dry-run'],modified).status, 0); count++;

  // Refuse a truncated export even with a matching hash for those few rows.
  const truncated = join(root, 'truncated.jsonl');
  await writeFile(truncated, JSON.stringify(unsafe)+'\n');
  const truncatedHash = sha(`${unsafe.version}:${unsafe.name}:${sha(unsafe.sql)}`);
  const denied = run(['--write','--adopt-remote-with-backup',
    '--expected-inventory-sha256',truncatedHash],truncated);
  assert.notEqual(denied.status,0); count++;
  assert.match(denied.stderr,/REMOTE_HISTORY_INCOMPLETE/); count++;
  assert.equal(await readFile(join(migrate,nextName),'utf8'),next.sql); count++;
  console.log(`STEP11_MIGRATION_RECOVERY=PASS (${count}/${count} assertions; no SQL applied to database)`);
} finally {
  await rm(root, { recursive: true, force: true });
}
