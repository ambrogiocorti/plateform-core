import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { cleanInstallPlan } from './clean-install-plan.mjs';
import { applicationCatalogQueries, compareCleanInstallCatalog } from './clean-install-catalog.mjs';
import { extendedCatalogQuery } from './clean-install-extended-catalog-query.mjs';

import { nativeCIContext, nativeAssert as assert } from './native-ci-context.mjs';

const {
  env,
  run,
  network,
  psql,
  json,
  platform,
  status,
  api,
  request: fetchNative,
} = await nativeCIContext();

if (process.argv.includes('--prepare')) {
  // Keep the exact cron.schedule statements in the history while preventing
  // automatic execution, including fixed Development URLs in legacy routines.
  // Supabase's application owner is not a system superuser. Configure only
  // this already-verified local container via its platform administrator.
  for (const sql of [
    "alter system set cron.launch_active_jobs = 'off'",
    'select pg_reload_conf()',
  ]) {
    await run(
      'docker',
      [
        'exec',
        '-e',
        'PGPASSWORD',
        'supabase_db_plateform-clean-install-ci',
        'psql',
        '-X',
        '-w',
        '-q',
        '-U',
        'supabase_admin',
        '-d',
        'postgres',
        '--set',
        'ON_ERROR_STOP=1',
        '--command',
        sql,
      ],
      { env },
    );
  }
  let disabled = false;
  for (let attempt = 0; attempt < 10; attempt++) {
    disabled = (await psql('show cron.launch_active_jobs')) === 'off';
    if (disabled) break;
    await delay(100);
  }
  assert(disabled, 'NATIVE_CI_CRON_NOT_DISABLED');
  // Exercise the same owner-level barrier required on managed Supabase. The
  // system-wide Docker switch remains an independent layer of CI isolation.
  try {
    await run(
      process.env.PSQL_BIN || 'psql',
      [
        '-X',
        '-w',
        '-q',
        '--set',
        'ON_ERROR_STOP=1',
        '--set',
        'VERBOSITY=sqlstate',
        '--file',
        'supabase/clean-install/disarm-cron.sql',
      ],
      { env },
    );
  } catch (error) {
    const stderr = String(error.stderr || '');
    const state = stderr.match(/ERROR:\s+([A-Z0-9]{5})\b/)?.[1];
    const line = stderr.match(/disarm-cron\.sql:(\d+):/)?.[1];
    throw new Error(
      `NATIVE_CI_CRON_BARRIER_FAILED:${state || 'PSQL_ERROR'}:line_${line || 'unknown'}`,
    );
  }
  await psql(`select cron.schedule('plateform-barrier-regression','* * * * *','select 1');
    update cron.job set active=true where jobname='plateform-barrier-regression';`);
  assert(
    (await psql(`select not active from cron.job where jobname='plateform-barrier-regression'`)) ===
      't',
    'NATIVE_CI_CRON_BARRIER_ALLOWED_ACTIVATION',
  );
  await psql("select cron.unschedule('plateform-barrier-regression')");
  assert(
    (await psql('select count(*) from cron.job')) === '0',
    'NATIVE_CI_CRON_BARRIER_FIXTURE_REMAINED',
  );
  console.log(JSON.stringify({ platform, cron_disabled: true, phase: 'platform_prepared' }));
} else {
  const plan = await cleanInstallPlan();
  const reference = {
    ...JSON.parse(
      await readFile('docs/evidence/clean-install-application-catalog-2026-10-09.json', 'utf8'),
    ),
    ...JSON.parse(
      await readFile('docs/evidence/clean-install-extended-catalog-2026-10-09.json', 'utf8'),
    ),
  };
  const actual = {};
  for (const [kind, query] of Object.entries(applicationCatalogQueries)) {
    actual[kind] = await json(`select coalesce(json_agg(x),'[]'::json) from (${query}) x`);
  }
  Object.assign(actual, await json(extendedCatalogQuery));
  const catalog = compareCleanInstallCatalog({
    plan,
    reference,
    actual,
    substrate: `Supabase Docker / native PostgreSQL ${platform.server_version}`,
  });
  // Report only catalog object identities/metadata, never application data.
  console.log(JSON.stringify(catalog));
  assert(catalog.ok, 'NATIVE_CI_APPLICATION_CATALOG_DRIFT');
  const releaseDefinitions = await json(`select json_agg(x order by x.key collate "C") from (
    select key,category,required,description from private.release_test_catalog) x`);
  assert(
    JSON.stringify(releaseDefinitions) === JSON.stringify(plan.releaseTestCatalog),
    'NATIVE_CI_RELEASE_CATALOG_DEFINITION_DRIFT',
  );
  const ledgerSql = `select json_agg(x order by x.version) from (
    select version,name,encode(extensions.digest(array_to_string(statements,E'\\n'),'sha256'),'hex')
      as sha256 from supabase_migrations.schema_migrations) x`;
  const ledger = await json(ledgerSql);
  assert(
    JSON.stringify(ledger) ===
      JSON.stringify(
        plan.migrations.map(({ version, name, sha256 }) => ({ version, name, sha256 })),
      ),
    'NATIVE_CI_MIGRATION_LEDGER_MISMATCH',
  );
  const tables = await json(`select json_agg(x order by x.name) from (
    select n.nspname||'.'||c.relname as name,c.relrowsecurity as rls,
      (has_table_privilege('anon',c.oid,'SELECT') or
       has_table_privilege('authenticated',c.oid,'SELECT') or
       has_table_privilege('service_role',c.oid,'SELECT')) as exposed
    from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='private' and c.relname like 'continuity_rehearsal_%'
      and c.relkind='r') x`);
  assert(
    JSON.stringify(tables.map((row) => row.name)) ===
      JSON.stringify([...plan.bootstrapManifest.tables].sort()) &&
      tables.every((row) => row.rls && !row.exposed),
    'NATIVE_CI_REHEARSAL_TABLE_EXPOSURE',
  );
  for (const signature of plan.bootstrapManifest.routines) {
    assert(
      (await psql(`select to_regprocedure('${signature}') is not null and
      not has_function_privilege('anon',to_regprocedure('${signature}'),'EXECUTE')`)) === 't',
      'NATIVE_CI_RECOVERED_RPC_PERMISSION_DRIFT',
    );
  }
  const evidence = await json(`select json_build_object(
    'test_pass',(select count(*) from private.release_test_results where status='PASS'),
    'gate_pass',(select count(*) from private.release_gate_checks where status='PASS'),
    'preserved_test_claims',(select count(*) from private.release_test_results
      where status='PENDING' and evidence->>'classification'='UNVERIFIED_LEGACY_CLAIM'
        and evidence ?& array['previous_status','previous_evidence','previous_executed_at','previous_executed_by']),
    'preserved_gate_claims',(select count(*) from private.release_gate_checks
      where status='PENDING' and evidence like 'UNVERIFIED_LEGACY_CLAIM: %'
        and substring(evidence from length('UNVERIFIED_LEGACY_CLAIM: ')+1)::jsonb
          ?& array['previous_status','previous_evidence','previous_checked_at','previous_checked_by']),
    'legacy_test_claims_without_metadata',(select count(*) from private.release_test_results
      where evidence->>'classification'='UNVERIFIED_LEGACY_CLAIM' and not
        (evidence ?& array['previous_status','previous_evidence','previous_executed_at','previous_executed_by'])),
    'legacy_gate_claims_without_metadata',(select count(*) from private.release_gate_checks
      where evidence like 'UNVERIFIED_LEGACY_CLAIM: %' and not
        (substring(evidence from length('UNVERIFIED_LEGACY_CLAIM: ')+1)::jsonb
          ?& array['previous_status','previous_evidence','previous_checked_at','previous_checked_by'])),
    'provenance_pending',exists(select 1 from private.release_gate_checks
      where key='RELEASE_EVIDENCE_PROVENANCE' and required and status='PENDING'),
    'required_total',(public.release_test_gate()->>'required_total')::int,
    'required_passed',(public.release_test_gate()->>'required_passed')::int,
    'gate_ok',(public.release_test_gate()->>'ok')::boolean)`);
  assert(
    evidence.test_pass === 0 &&
      evidence.gate_pass === 0 &&
      evidence.preserved_test_claims > 0 &&
      // Historic SQL seeds test claims, but manual Development gate claims
      // are not copied into a fresh install. Explicit upgrade fixtures cover
      // their preservation separately; every observed legacy claim is checked.
      evidence.legacy_test_claims_without_metadata === 0 &&
      evidence.legacy_gate_claims_without_metadata === 0 &&
      evidence.provenance_pending &&
      evidence.required_total === plan.releaseTestCatalog.filter((row) => row.required).length &&
      evidence.required_total > 0 &&
      evidence.required_passed === 0 &&
      evidence.gate_ok === false,
    'NATIVE_CI_UNVERIFIED_RELEASE_CERTIFICATION',
  );
  const attempts = [
    `select public.record_release_test_result('RLS_GLOBAL','PASS','{"claim":"native CI rejection probe"}'::jsonb,'ci')`,
    `update private.release_test_results set status='PASS' where key='RLS_GLOBAL'`,
    `select public.set_release_gate_check('AUTH_LEAKED_PASSWORD_PROTECTION','PASS','native CI rejection probe','ci')`,
    `update private.release_gate_checks set status='PASS' where key='AUTH_LEAKED_PASSWORD_PROTECTION'`,
  ];
  for (const attempt of attempts) {
    await psql(`do $probe$ begin begin ${attempt};
      raise exception 'NATIVE_CI_ACCEPTED_UNATTESTED_PASS';
      exception when raise_exception then
        if sqlerrm <> 'ATTESTED_CI_EVIDENCE_REQUIRED' then raise; end if;
      end; end $probe$`);
  }
  let repeatBlocked = false;
  try {
    await run(process.execPath, ['scripts/install-database.mjs'], { env: process.env });
  } catch (error) {
    repeatBlocked = String(error.stderr || '').includes(
      'CLEAN_INSTALL_REQUIRES_EMPTY_APPLICATION_SCHEMAS',
    );
  }
  assert(repeatBlocked, 'NATIVE_CI_REPEAT_INSTALL_NOT_BLOCKED');
  assert(
    JSON.stringify(await json(ledgerSql)) === JSON.stringify(ledger),
    'NATIVE_CI_REPEAT_INSTALL_CHANGED_LEDGER',
  );
  assert((await psql('show cron.launch_active_jobs')) === 'off', 'NATIVE_CI_CRON_ENABLED');
  assert(
    (await psql(`select count(*) from cron.job where active`)) === '0' &&
      (await psql(`select count(*) from cron.job_run_details`)) === '0',
    'NATIVE_CI_CRON_BARRIER_EXECUTION_DETECTED',
  );
  const request = (path, key, rpc = false) =>
    fetchNative(new URL(path, api), {
      method: rpc ? 'POST' : 'GET',
      headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      ...(rpc ? { body: '{}' } : {}),
      signal: AbortSignal.timeout(10000),
    });
  for (const path of ['/auth/v1/health', '/storage/v1/status']) {
    assert((await request(path, status.ANON_KEY)).ok, 'NATIVE_CI_PLATFORM_HTTP_UNHEALTHY');
  }
  await psql("notify pgrst, 'reload schema'");
  let rpc;
  for (let attempt = 0; attempt < 20; attempt++) {
    rpc = await request('/rest/v1/rpc/release_test_gate', status.SERVICE_ROLE_KEY, true);
    if (rpc.ok) break;
    await delay(200);
  }
  assert(rpc.ok, 'NATIVE_CI_SERVICE_ROLE_RPC_FAILED');
  const gate = await rpc.json();
  assert(
    gate.ok === false && gate.required_passed === 0 && gate.required_total > 0,
    'NATIVE_CI_HTTP_UNVERIFIED_RELEASE_CERTIFICATION',
  );
  const denied = await request('/rest/v1/rpc/release_test_gate', status.ANON_KEY, true);
  assert([401, 403].includes(denied.status), 'NATIVE_CI_ANON_PRIVILEGED_RPC_EXPOSED');
  const report = {
    classification: 'OBSERVED_NATIVE_SUPABASE_CI_NOT_COMMERCIAL_RELEASE_ATTESTATION',
    platform,
    catalog,
    migrations: ledger.length,
    release_test_catalog: {
      definitions: releaseDefinitions.length,
      recovered_definitions: plan.bootstrapManifest.recovered_release_test_keys.length,
      definitions_sha256: plan.bootstrapManifest.release_test_catalog_sha256,
    },
    inventory_sha256: plan.inventorySha256,
    historical_inventory_sha256: plan.bootstrapManifest.historical_inventory_sha256,
    bootstrap_sha256: plan.bootstrapManifest.bootstrap_sha256,
    postlude_sha256: plan.bootstrapManifest.postlude_sha256,
    evidence,
    rejected_pass_writes: attempts.length,
    repeat_install_blocked: repeatBlocked,
    cron_disabled: true,
    external_container_network: 'bridge_with_verified_egress_drop_rule',
    network: {
      containers: Object.keys(network.Containers).length,
      ipv6_disabled: true,
      loopback_ports: true,
    },
    http: {
      auth_health: true,
      storage_health: true,
      service_role_gate: true,
      anon_gate_denied: true,
    },
    source_commit: process.env.GITHUB_SHA || null,
    workflow_run_id: process.env.GITHUB_RUN_ID || null,
    hosted_supabase_certified: false,
    commercial_release_ready: false,
    remaining: [
      'Hosted installation/restore',
      'Authenticated user sessions and scope HTTP scenarios',
      'Realtime and native concurrency',
      'Current-schema restore',
      'Immutable CI evidence ingestion',
    ],
  };
  const output = JSON.stringify(report, null, 2) + '\n';
  await writeFile('.local/native-ci/verification.json', output, { mode: 0o600 });
  console.log(
    JSON.stringify({ ...report, report_sha256: createHash('sha256').update(output).digest('hex') }),
  );
}
