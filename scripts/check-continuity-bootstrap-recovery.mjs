import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const manifest = JSON.parse(await readFile('supabase/migration-manifest.json', 'utf8'));
const harness = await readFile('tests/database/harness.ts', 'utf8');
const file = '20261006100100_continuity_rehearsal_schema_recovery.sql';
const index = manifest.migrations.findIndex((row) => row.filename === file);
assert.equal(manifest.migrations.length, 482);
assert.ok(index >= 0 && index < manifest.migrations.length - 1);
assert.ok(manifest.migrations[index + 1].version > '20261006100100');
assert.ok(manifest.migrations.findIndex((x) => x.version === '20261006100248') > index);
assert.ok(
  !harness.includes("if (name === '20261006100248_step13_rehearsal_private_rls_hardening.sql')"),
);
const sql = await readFile('supabase/migrations/' + file, 'utf8');
const tables = [
  'continuity_rehearsal_blob',
  'continuity_rehearsal_key',
  'continuity_rehearsal_snapshot_manifest',
  'continuity_rehearsal_snapshot_rows',
  'continuity_rehearsal_snapshot_tables',
  'continuity_rehearsal_transfer_chunks',
  'continuity_rehearsal_transfer_key',
];
for (const t of tables) {
  assert.ok(sql.includes('CREATE TABLE IF NOT EXISTS private.' + t + ' ('), 'DDL for ' + t);
  assert.ok(
    sql.includes('ALTER TABLE private.' + t + ' ENABLE ROW LEVEL SECURITY;'),
    'RLS for ' + t,
  );
  assert.ok(sql.includes('private.' + t), 'scope for ' + t);
}
assert.ok(sql.includes('FROM PUBLIC, anon, authenticated, service_role;'));
console.log('CONTINUITY_REHEARSAL_BOOTSTRAP_TRACKED=PASSED');
