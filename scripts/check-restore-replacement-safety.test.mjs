import assert from 'node:assert/strict';
import test from 'node:test';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkPrerequisites } from '../tools/restore-worker/config.mjs';

const startFile = new URL('../tools/restore-worker/start.mjs', import.meta.url);

test('replacement preflight actually executes a complete read-only occupancy query', async () => {
  const root = await mkdtemp(join(tmpdir(), 'plateform-replacement-preflight-'));
  const stub = join(root, 'psql-fixture');
  const previous = process.env.PLATEFORM_MOCK_PSQL_ANSWER;
  const program = [
    '#!/usr/bin/env node',
    "const args = process.argv.slice(2);",
    "if (args.includes('--version')) { console.log('psql (PostgreSQL) 17'); process.exit(0); }",
    "const i = args.indexOf('--command');",
    "const sql = args[i + 1] || '';",
    "for (const fragment of ['information_schema.tables','auth.users','auth.identities','storage.buckets','storage.objects']) {",
    "  if (!sql.includes(fragment)) { console.error('MISSING_OCCUPANCY_PREDICATE'); process.exit(2); }",
    '}',
    'console.log(process.env.PLATEFORM_MOCK_PSQL_ANSWER ?? \'unexpected\');',
  ].join('\n') + '\n';

  try {
    await writeFile(stub, program, { mode: 0o700 });
    await chmod(stub, 0o700);
    const config = {
      backupRoot: root,
      psql: stub,
      leaseSeconds: 1800,
      targetProjectRef: 'replacementref',
      targetDatabaseUrl:
        'postgresql://postgres.replacementref:fixture@aws-0-eu-west-1.pooler.supabase.com:5432/postgres',
    };

    process.env.PLATEFORM_MOCK_PSQL_ANSWER = 'true';
    const occupied = await checkPrerequisites(config);
    assert.equal(occupied.targetOccupied, true);
    await rm(occupied.temp, { recursive: true, force: true });

    process.env.PLATEFORM_MOCK_PSQL_ANSWER = 'false';
    const empty = await checkPrerequisites(config);
    assert.equal(empty.targetOccupied, false);
    await rm(empty.temp, { recursive: true, force: true });

    process.env.PLATEFORM_MOCK_PSQL_ANSWER = 'garbage';
    await assert.rejects(
      () => checkPrerequisites(config),
      /RESTORE_TARGET_PROBE_INVALID/,
    );
  } finally {
    if (previous === undefined) delete process.env.PLATEFORM_MOCK_PSQL_ANSWER;
    else process.env.PLATEFORM_MOCK_PSQL_ANSWER = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test('replacement readiness and destructive actions are ordered safely', async () => {
  const source = await readFile(startFile, 'utf8');
  const check = source.indexOf("if (mode === '--check')");
  const ready = source.indexOf("status: 'READY'", check);
  const deny = source.indexOf("if (prerequisite.targetOccupied)", check);
  const claim = source.indexOf('await claimRestore(config)');
  const restore = source.indexOf('await restoreDatabase(config, files)');
  const occupiedBeforeRestore = source.indexOf("if (prerequisite.targetOccupied)", source.indexOf("if (job.status === 'RESTORING')"));
  assert.ok(check >= 0 && deny > check && ready > deny, 'readiness must refuse occupied targets');
  assert.ok(claim > check && restore > claim && occupiedBeforeRestore < restore);
  assert.ok(source.includes('RESTORE_TARGET_NOT_EMPTY'));
  assert.ok(source.includes("job.status === 'VERIFYING'"), 'verification-only resume preserved');
});
