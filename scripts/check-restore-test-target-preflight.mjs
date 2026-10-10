import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const config = readFileSync('tools/restore-test-worker/config.mjs', 'utf8');
const worker = readFileSync('tools/restore-test-worker/start.mjs', 'utf8');

test('target probe rejects existing app tables, Auth identities and Storage objects', () => {
  for (const fragment of [
    "table_schema in ('public','private')",
    "from auth.users",
    "from auth.identities",
    "from storage.buckets",
    "from storage.objects",
    "RESTORE_TARGET_PROBE_INVALID",
  ]) {
    assert.ok(config.includes(fragment), `Missing target occupancy check: ${fragment}`);
  }
});

test('readiness must not return READY if the destination has existing content', () => {
  const check = worker.indexOf("if (mode === '--check')");
  const denied = worker.indexOf("if (prerequisite.targetOccupied)", check);
  const ready = worker.indexOf("status: 'READY'", check);
  assert.ok(check >= 0 && denied > check && ready > denied);
  assert.ok(worker.slice(denied, ready).includes('RESTORE_TARGET_NOT_EMPTY'));
});

test('restoring refuses occupied target and fails before database writes', () => {
  const occupied = worker.indexOf('if (prerequisite.targetOccupied)');
  const restore = worker.indexOf('await restoreDatabase(config, files)');
  assert.ok(occupied >= 0 && restore > occupied);
  assert.ok(worker.slice(occupied, restore).includes('RESTORE_TARGET_NOT_EMPTY'));
});

test('an already VERIFYING job remains a verification-only path', () => {
  const restoring = worker.indexOf("if (job.status === 'RESTORING')");
  const resuming = worker.indexOf("} else if (job.status === 'VERIFYING')");
  const restore = worker.indexOf('await restoreDatabase(config, files)');
  assert.ok(restoring >= 0 && restore > restoring && resuming > restore);
  assert.ok(worker.slice(resuming, resuming + 220).includes('verifying = true'));
});

test('prerequisite runs before queue claim', () => {
  const preflight = worker.indexOf('await checkPrerequisites(config)');
  const claim = worker.indexOf('await claimRestoreTest(config)');
  assert.ok(preflight >= 0 && claim > preflight);
});
