#!/usr/bin/env node
// Local disaster-recovery rehearsal (Step 12): backup → destruction → restore on
// a DISPOSABLE PostgreSQL 16 cluster created and deleted by this script.
//
//   npm run continuity:local-dr -- [--evidence docs/evidence/<file>.json]
//
// It drives the REAL continuity code: the backup worker job pipeline
// (dump → AES-256-GCM → HMAC manifest → replica → finish_backup_job), the
// restore-test worker pipeline (claim → decrypt → restore → 14 gates →
// finish_restore_job) and the offline disaster restore. Only the transports
// are local: pg_dump instead of the Supabase CLI container and a 127.0.0.1
// PostgREST/Storage stand-in. Nothing here can reach a remote database.
import { cp, mkdtemp, readdir, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { run, startCluster } from './cluster.mjs';
import { platformPrelude, SUPABASE_PREFIX } from './fixture.mjs';
import { startLocalSupabase } from './local-supabase.mjs';
import { seed } from './seed.mjs';
import {
  tableFingerprint,
  auditState,
  auditImmutabilityProbe,
  securitySurface,
  surfaceDiff,
} from './fingerprint.mjs';
import { processJob as backupJob } from '../backup-worker/start.mjs';
import { processJob as restoreTestJob } from '../restore-test-worker/start.mjs';
import { loadEncryptionKeyring } from '../backup-worker/keyring.mjs';
import {
  DISASTER_RESTORE_GATES,
  activateSchedules,
  disasterRestore,
  loadAuthenticatedBackup,
} from '../disaster-restore/restore.mjs';
import { decryptVerified } from '../backup-worker/crypto.mjs';
import { TARGET_OCCUPANCY_SQL, parseTargetOccupancy } from '../continuity/target-occupancy.mjs';

const repoRoot = pathToFileURL(resolve(fileURLToPath(new URL('../..', import.meta.url))) + '/');
const evidencePath = process.argv.includes('--evidence')
  ? resolve(process.argv[process.argv.indexOf('--evidence') + 1])
  : null;
const t0 = Date.now();
const timings = {};
const step = async (name, fn) => {
  const start = Date.now();
  process.stdout.write(`… ${name}\n`);
  try {
    return await fn();
  } finally {
    timings[name] = Date.now() - start;
  }
};
const evidence = { kind: 'LOCAL_DR_REHEARSAL', gates: {}, findings: [] };
const gate = (name, ok, detail) => {
  evidence.gates[name] = { ok: Boolean(ok), ...(detail === undefined ? {} : { detail }) };
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
};

const cluster = await startCluster();
const git = async (...args) =>
  (
    await run('git', ['-C', fileURLToPath(repoRoot), ...args], { allowFailure: true })
  ).stdout.trim();
evidence.environment = {
  generated_at: new Date().toISOString(),
  git_commit: await git('rev-parse', 'HEAD'),
  git_worktree_clean:
    (await git('status', '--porcelain', '--', 'tools', 'supabase', 'scripts')) === '',
  postgres: (await cluster.psql('postgres', 'select version()')).stdout.trim(),
  node: process.version,
  target: 'disposable local PostgreSQL 16 cluster (Unix socket only), deleted after the run',
};
process.env.PLATEFORM_PG_BIN = cluster.bin;
const work = await mkdtemp(join(cluster.socket, 'work-'));
const roots = {
  backup: join(work, 'backup-primary'),
  replica: join(work, 'backup-replica'),
  sourceStore: join(work, 'storage-source'),
  testStore: join(work, 'storage-restore-test'),
  drStore: join(work, 'storage-disaster'),
  temp: join(work, 'tmp'),
};
for (const dir of Object.values(roots)) await mkdir(dir, { recursive: true, mode: 0o700 });
const keyId = 'local-dr-key-1';
const keyBase64 = randomBytes(32).toString('base64');
const services = [];
let exitCode = 1;

try {
  const migrations = (await readdir(new URL('supabase/migrations/', repoRoot)))
    .filter((f) => SUPABASE_PREFIX.test(f))
    .sort();

  await step('source: create installation from all migrations', async () => {
    await cluster.psql('postgres', 'create database plateform_source');
    await cluster.psql('plateform_source', await platformPrelude(repoRoot));
    for (const file of migrations) {
      const raw = await readFile(new URL(`supabase/migrations/${file}`, repoRoot), 'utf8');
      const sql = raw.replace(/^create extension if not exists pg_cron;\s*$/gim, '');
      const [, version, name] = file.match(SUPABASE_PREFIX);
      const tag = `$h${randomBytes(6).toString('hex')}$`;
      const result = await cluster.psql(
        'plateform_source',
        `${sql}\n;insert into supabase_migrations.schema_migrations(version,name,statements) values('${version}','${name}',array[${tag}${raw}${tag}]);`,
        { allowFailure: true },
      );
      if (result.code !== 0)
        throw new Error(`MIGRATION_FAILED:${file}:${result.stderr.slice(0, 400)}`);
    }
    evidence.migrations = { count: migrations.length, latest: migrations.at(-1) };
  });

  const seeded = await step('source: seed restaurant data through RPCs', () =>
    seed({ cluster, database: 'plateform_source', repoRoot, storeRoot: roots.sourceStore }),
  );
  evidence.seed = seeded;

  const source = await startLocalSupabase({
    cluster,
    database: 'plateform_source',
    storeRoot: roots.sourceStore,
    name: 'source',
  });
  services.push(source);
  const backupConfig = {
    supabaseUrl: source.url,
    sourceProjectRef: 'localsource',
    serviceRoleKey: source.serviceKey,
    databaseUrl: cluster.url('plateform_source'),
    backupRoot: roots.backup,
    replicaRoot: roots.replica,
    encryptionKey: Buffer.from(keyBase64, 'base64'),
    encryptionKeyId: keyId,
    supabaseCli: fileURLToPath(new URL('./supabase-cli.mjs', import.meta.url)),
    psql: join(cluster.bin, 'psql'),
    leaseSeconds: 1800,
  };

  // 1. Backup through the real control plane and worker pipeline.
  const job = await step('backup: enqueue + claim through control plane', async () => {
    const queued = JSON.parse(await source.sql(`select public.enqueue_scheduled_backup(30)`));
    const claimed = JSON.parse(await source.sql(`select public.claim_backup_job(1800)`));
    if (claimed?.id !== queued.id) throw new Error('BACKUP_CLAIM_MISMATCH');
    return claimed;
  });
  const before = await step('source: fingerprint at backup time', async () => ({
    tables: await tableFingerprint(cluster, 'plateform_source'),
    audit: await auditState(cluster, 'plateform_source'),
    surface: await securitySurface(cluster, 'plateform_source'),
    sessions: Number(
      (await cluster.psql('plateform_source', 'select count(*) from private.staff_sessions'))
        .stdout,
    ),
  }));
  const backup = await step('backup: worker job (dump, encrypt, HMAC, replica, finish)', () =>
    backupJob(backupConfig, job),
  );
  evidence.backup = backup;
  const registered = JSON.parse(
    await source.sql(
      `select to_jsonb(b)-'manifest'-'lease_token' from public.backup_metadata b where id='${job.id}'`,
    ),
  );
  gate(
    'backup_registered_succeeded',
    registered.status === 'SUCCEEDED' && registered.integrity_verified === true,
    {
      status: registered.status,
      schema_version: registered.schema_version,
      size_bytes: registered.size_bytes,
      object_count: registered.object_count,
    },
  );

  // 2. Isolated restore test through the real restore-test worker pipeline.
  const keyring = loadEncryptionKeyring(keyId, keyBase64);
  await cluster.psql('postgres', 'create database plateform_restore_test');
  await cluster.psql(
    'plateform_restore_test',
    await platformPrelude(repoRoot, { migrationHistory: false }),
  );
  const target = await startLocalSupabase({
    cluster,
    database: 'plateform_restore_test',
    storeRoot: roots.testStore,
    name: 'restore-test',
  });
  services.push(target);
  const restoreTestConfig = {
    sourceUrl: source.url,
    sourceServiceRoleKey: source.serviceKey,
    backupRoot: roots.backup,
    encryptionKeys: keyring,
    targetUrl: target.url,
    targetServiceRoleKey: target.serviceKey,
    targetDatabaseUrl: cluster.url('plateform_restore_test'),
    targetProjectRef: 'localrestoretest',
    psql: join(cluster.bin, 'psql'),
    leaseSeconds: 1800,
  };
  const restoreTest = await step(
    'restore test: worker job (decrypt, restore, 16 gates)',
    async () => {
      const occupied = (await cluster.psql('plateform_restore_test', TARGET_OCCUPANCY_SQL)).stdout;
      const prerequisite = { targetOccupied: parseTargetOccupancy(occupied) };
      if (prerequisite.targetOccupied) throw new Error('RESTORE_TARGET_NOT_EMPTY');
      await source.sql(`select public.enqueue_restore_test_job('${job.id}')`);
      const claimed = JSON.parse(await source.sql(`select public.claim_restore_test_job(1800)`));
      const temp = await mkdtemp(join(roots.temp, 'restore-test-'));
      try {
        return await restoreTestJob(restoreTestConfig, claimed, temp, prerequisite);
      } catch (error) {
        evidence.restore_test_surface_diff = surfaceDiff(
          before.surface,
          await securitySurface(cluster, 'plateform_restore_test'),
        );
        console.error(JSON.stringify(evidence.restore_test_surface_diff, null, 2));
        throw error;
      } finally {
        await rm(temp, { recursive: true, force: true });
      }
    },
  );
  evidence.restore_test = restoreTest;
  const restoreRow = JSON.parse(
    await source.sql(
      `select json_build_object('status',r.status,'mode',r.mode,'verified_at',r.verified_at,'last_restore_test_at',b.last_restore_test_at)
       from public.restore_jobs r join public.backup_metadata b on b.id=r.backup_id where r.backup_id='${job.id}'`,
    ),
  );
  gate(
    'restore_test_registered_succeeded',
    restoreRow.status === 'SUCCEEDED' && restoreRow.last_restore_test_at,
    restoreRow,
  );
  const diff = (a, b, skip = []) =>
    [...new Set([...Object.keys(a), ...Object.keys(b)])]
      .filter((t) => !skip.includes(t) && JSON.stringify(a[t]) !== JSON.stringify(b[t]))
      .map((t) => ({ table: t, before: a[t] ?? null, after: b[t] ?? null }));
  const afterTest = {
    tables: await tableFingerprint(cluster, 'plateform_restore_test'),
    audit: await auditState(cluster, 'plateform_restore_test'),
    surface: await securitySurface(cluster, 'plateform_restore_test'),
  };
  const testDiff = diff(before.tables, afterTest.tables);
  gate('restore_test_tables_identical', testDiff.length === 0, {
    tables: Object.keys(before.tables).length,
    rows: Object.values(before.tables).reduce((sum, t) => sum + t.rows, 0),
    differences: testDiff,
  });
  gate(
    'restore_test_audit_identical',
    afterTest.audit.sha256 === before.audit.sha256 &&
      afterTest.audit.events === before.audit.events,
    { events: afterTest.audit.events, sha256: afterTest.audit.sha256 },
  );
  const testSurface = surfaceDiff(before.surface, afterTest.surface);
  gate(
    'restore_test_security_surface_identical',
    Object.keys(testSurface).every((k) => k === 'cron_jobs'),
    testSurface,
  );

  // 3. Activity after the backup: lost by design, it measures the RPO window.
  await cluster.psql(
    'plateform_source',
    `select private.audit('LOCAL_DR_POST_BACKUP_MARKER','restaurant_profile',null,null,null,'{"note":"written after backup"}'::jsonb)`,
  );

  // 4. Disaster: the source database, its Storage bytes, the PRIMARY backup copy
  //    and the source control plane are destroyed. Only the replica survives.
  const disasterAt = Date.now();
  await step('disaster: destroy source database, storage and primary backup', async () => {
    await source.close();
    services.splice(services.indexOf(source), 1);
    await cluster.psql('postgres', 'drop database plateform_source with (force)');
    await rm(roots.sourceStore, { recursive: true, force: true });
    await rm(join(roots.backup, job.id), { recursive: true, force: true });
  });
  const gone = (
    await cluster.psql(
      'postgres',
      `select count(*) from pg_database where datname='plateform_source'`,
    )
  ).stdout.trim();
  gate('disaster_source_destroyed', gone === '0', { primary_backup_removed: true });

  // 5. Recovery on a brand-new empty installation from the replica copy only.
  await cluster.psql('postgres', 'create database plateform_recovered');
  await cluster.psql(
    'plateform_recovered',
    await platformPrelude(repoRoot, { migrationHistory: false }),
  );
  const recovered = await startLocalSupabase({
    cluster,
    database: 'plateform_recovered',
    storeRoot: roots.drStore,
    name: 'recovered',
  });
  services.push(recovered);
  const drConfig = {
    backupDir: join(roots.replica, job.id),
    encryptionKeys: keyring,
    targetUrl: recovered.url,
    targetServiceRoleKey: recovered.serviceKey,
    targetDatabaseUrl: cluster.url('plateform_recovered'),
    targetProjectRef: 'localrecovered',
    targetReference: 'local://plateform_recovered',
    operatorId: '20000000-0000-4000-8000-000000000002',
    psql: join(cluster.bin, 'psql'),
  };
  const { createClient } = await import('@supabase/supabase-js');
  const dr = await step('disaster restore: replica → empty installation (16 gates)', async () => {
    const temp = await mkdtemp(join(roots.temp, 'dr-'));
    try {
      return await disasterRestore({ ...drConfig, temp }, createClient);
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });
  const rtoMs = Date.now() - disasterAt;
  evidence.disaster_restore = { ...dr, verification: dr.verification };
  gate(
    'disaster_restore_gates',
    true,
    Object.fromEntries(DISASTER_RESTORE_GATES.map((k) => [k, dr.verification[k]])),
  );
  const control = JSON.parse(
    (
      await cluster.psql(
        'plateform_recovered',
        `select json_build_object(
          'backup',(select json_build_object('status',status,'integrity_verified',integrity_verified,'reconciled_by',verification->>'reconciled_by') from public.backup_metadata where id='${job.id}'),
          'restore',(select json_build_object('status',status,'mode',mode,'requested_by',requested_by,'target_reference',target_reference) from public.restore_jobs where backup_id='${job.id}' and mode='RESTORE'))`,
      )
    ).stdout.trim(),
  );
  gate(
    'disaster_restore_registered_cutover_required',
    control.backup?.status === 'SUCCEEDED' && control.restore?.status === 'CUTOVER_REQUIRED',
    control,
  );

  const recoveredState = {
    tables: await tableFingerprint(cluster, 'plateform_recovered'),
    audit: await auditState(cluster, 'plateform_recovered'),
    surface: await securitySurface(cluster, 'plateform_recovered'),
  };
  // Control-plane rows legitimately advance (backup finalised, restore recorded).
  const controlPlane = ['public.backup_metadata', 'public.restore_jobs', 'public.audit_log'];
  const drDiff = diff(before.tables, recoveredState.tables, controlPlane);
  gate('recovered_tables_identical', drDiff.length === 0, {
    compared_tables: Object.keys(before.tables).length - controlPlane.length,
    differences: drDiff,
  });
  const prefix = JSON.parse(
    (
      await cluster.psql(
        'plateform_recovered',
        `select json_build_object(
          'sha256',encode(extensions.digest(coalesce((select string_agg(x,E'\\n' order by ts,id) from (select to_jsonb(a)::text x,a.timestamp ts,a.id from public.audit_log a order by a.timestamp,a.id limit ${before.audit.events}) p),''),'sha256'),'hex'),
          'added',(select json_agg(action order by timestamp,id) from (select action,timestamp,id from public.audit_log order by timestamp,id offset ${before.audit.events}) q),
          'marker',(select count(*) from public.audit_log where action='LOCAL_DR_POST_BACKUP_MARKER'))`,
      )
    ).stdout.trim(),
  );
  gate('recovered_audit_prefix_identical', prefix.sha256 === before.audit.sha256, {
    events_before: before.audit.events,
    events_after: recoveredState.audit.events,
    appended_by_recovery: prefix.added,
  });
  gate('rpo_post_backup_activity_absent', Number(prefix.marker) === 0, {
    note: 'Writes after the backup are lost by design; RPO = time since last successful backup.',
  });
  gate(
    'recovered_audit_append_only',
    recoveredState.audit.violations === 0 &&
      recoveredState.audit.event_triggers === 2 &&
      recoveredState.audit.pause_trigger === 0,
    recoveredState.audit,
  );
  const probe = await auditImmutabilityProbe(cluster, 'plateform_recovered');
  gate('recovered_audit_mutation_rejected', probe.rejected === probe.attempts, {
    attempts: probe.attempts,
    rejected: probe.rejected,
  });
  const drSurface = surfaceDiff(before.surface, recoveredState.surface);
  gate(
    'recovered_security_surface_identical',
    Object.keys(drSurface).every((k) => k === 'cron_jobs'),
    drSurface,
  );

  // 6. Application smoke on the recovered installation.
  const menu = await cluster.psql(
    'plateform_recovered',
    `begin; set local role anon; select jsonb_array_length(public.get_public_menu('10000000-0000-4000-8000-000000000001')); commit;`,
    { allowFailure: true },
  );
  gate('recovered_public_menu_served', menu.code === 0 && Number(menu.stdout.trim()) >= 1, {
    dishes: menu.stdout.trim(),
  });
  const sessions = JSON.parse(
    (
      await cluster.psql(
        'plateform_recovered',
        `select json_build_object('staff_sessions',(select count(*) from private.staff_sessions),
          'auth_sessions',(select count(*) from auth.sessions),'refresh_tokens',(select count(*) from auth.refresh_tokens))`,
      )
    ).stdout.trim(),
  );
  gate(
    'recovered_runtime_sessions_invalidated',
    before.sessions > 0 && Object.values(sessions).every((n) => Number(n) === 0),
    { before: before.sessions, after: sessions },
  );

  // 7. Fail-closed checks on the surviving copy.
  const negative = {};
  const expectFailure = async (name, fn, pattern) => {
    try {
      await fn();
      negative[name] = 'NOT_REJECTED';
    } catch (error) {
      negative[name] = pattern.test(String(error?.message))
        ? 'REJECTED'
        : `UNEXPECTED:${error?.message}`;
    }
  };
  await expectFailure(
    'occupied_target',
    async () => {
      const temp = await mkdtemp(join(roots.temp, 'dr-again-'));
      try {
        await disasterRestore({ ...drConfig, temp }, createClient);
      } finally {
        await rm(temp, { recursive: true, force: true });
      }
    },
    /RESTORE_TARGET_NOT_EMPTY/,
  );
  await expectFailure(
    'wrong_key',
    () =>
      loadAuthenticatedBackup(
        drConfig.backupDir,
        loadEncryptionKeyring(keyId, randomBytes(32).toString('base64')),
      ),
    /BACKUP_MANIFEST_AUTH_MISMATCH/,
  );
  const tamperedRoot = join(work, 'tampered');
  await mkdir(tamperedRoot, { mode: 0o700 });
  await cp(drConfig.backupDir, join(tamperedRoot, job.id), { recursive: true });
  const manifestFile = join(tamperedRoot, job.id, 'manifest.json');
  await writeFile(
    manifestFile,
    (await readFile(manifestFile, 'utf8')).replace('"purpose":"SCHEDULED"', '"purpose":"MANUAL"'),
  );
  await expectFailure(
    'tampered_manifest',
    () => loadAuthenticatedBackup(join(tamperedRoot, job.id), keyring),
    /BACKUP_MANIFEST_AUTH_MISMATCH/,
  );
  const dataMeta = JSON.parse(
    await readFile(join(drConfig.backupDir, 'manifest.json'), 'utf8'),
  ).components.database.find((r) => r.file === 'data.sql.enc');
  const cipher = join(tamperedRoot, job.id, 'data.sql.enc');
  const bytes = await readFile(cipher);
  bytes[Math.floor(bytes.length / 2)] ^= 0xff;
  await writeFile(cipher, bytes);
  await expectFailure(
    'tampered_ciphertext',
    () => decryptVerified(cipher, join(roots.temp, 'never.sql'), keyring.get(keyId), dataMeta),
    /BACKUP_CIPHERTEXT_CHECKSUM_MISMATCH/,
  );
  gate(
    'fail_closed_checks',
    Object.values(negative).every((v) => v === 'REJECTED'),
    negative,
  );

  // 8. Cutover step: schedules come back only when explicitly re-armed.
  const schedules = await activateSchedules({ ...drConfig, temp: join(roots.temp, 'cutover') });
  gate(
    'cutover_schedules_rearmed',
    schedules.active === schedules.expected && schedules.expected > 0,
    schedules,
  );

  evidence.measured = {
    rto_local_ms: rtoMs,
    note: 'Local disposable PostgreSQL 16; not a production RTO. Hosted Supabase timings must be measured in staging.',
    backup_size_bytes: backup.sizeBytes,
    replica_files: backup.replicaFiles,
  };
  const failed = Object.entries(evidence.gates).filter(([, g]) => !g.ok);
  evidence.result = failed.length ? 'FAILED' : 'PASSED';
  console.log(
    `LOCAL_DR_REHEARSAL=${evidence.result} gates=${Object.keys(evidence.gates).length} failed=${failed.length} rto_local_ms=${rtoMs}`,
  );
  if (failed.length) throw new Error(`LOCAL_DR_GATES_FAILED:${failed.map(([k]) => k).join(',')}`);
  exitCode = 0;
} catch (error) {
  console.error(error);
  evidence.error = String(error?.message ?? error).slice(0, 2000);
} finally {
  for (const s of services) await s.close().catch(() => undefined);
  await cluster.stop();
  timings.total = Date.now() - t0;
  evidence.timings_ms = timings;
  if (evidencePath) await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
}
process.exit(exitCode);
