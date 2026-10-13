import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  TARGET_OCCUPANCY_SQL,
  parseTargetOccupancy,
} from '../tools/continuity/target-occupancy.mjs';

assert.equal(parseTargetOccupancy('occupied\n'), true);
assert.equal(parseTargetOccupancy('empty\n'), false);
for (const output of ['', 'f', 't', 'false', 'ready', 'empty\noccupied', '0']) {
  assert.throws(() => parseTargetOccupancy(output), /RESTORE_TARGET_OCCUPANCY_UNVERIFIED/);
}
for (const required of [
  'pg_catalog.pg_class',
  "n.nspname IN ('public', 'private')",
  "c.relkind IN ('r', 'p')",
  'auth.users',
  'storage.objects',
  'pg_catalog.pg_proc',
]) {
  assert.ok(TARGET_OCCUPANCY_SQL.includes(required), required);
}
for (const prefix of ['restore-test-worker', 'restore-worker']) {
  const config = await readFile(`tools/${prefix}/config.mjs`, 'utf8');
  const start = await readFile(`tools/${prefix}/start.mjs`, 'utf8');
  assert.ok(config.includes('parseTargetOccupancy('));
  assert.ok(config.includes('TARGET_OCCUPANCY_SQL'));
  assert.ok(!config.includes("to_regclass('public.restaurant_profile')"));
  assert.ok(start.includes("blocked ? 'BLOCKED' : 'READY'"));
  assert.ok(start.includes('process.exit(blocked ? 2 : 0)'));
  const claimIndex = start.indexOf(prefix === 'restore-worker' ? 'claimRestore(config)' : 'claimRestoreTest(config)');
  const blockIndex = start.indexOf("if (prerequisite.targetOccupied === true)");
  assert.ok(blockIndex > 0 && claimIndex > blockIndex, 'must reject occupied target before claiming a job');
  assert.ok(start.includes("reason: 'RESTORE_TARGET_NOT_EMPTY'"));
}
console.log('RESTORE_TARGET_OCCUPANCY_FAIL_CLOSED=PASSED');
