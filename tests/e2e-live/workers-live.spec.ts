import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { anonKey, ids, password, serviceKey, sql, stack, staff } from './stack/seed.mjs';
import { reset } from './stack/stack.mjs';

// The six scheduled Edge Functions, served by the repository's Deno behind the stack gateway and
// called over HTTP exactly as pg_net would call them (bodies and headers of the database callers in
// 20261019090000: invoke_reservation_message_worker, invoke_reservation_deposit_no_show_worker,
// invoke_database_unavailable_chaos_probe, dispatch_continuity_retention_worker and the
// plateform-audit-archive-* cron commands). No browser. pg_net itself is not on this stack.

const workers = JSON.parse(readFileSync('tests/e2e-live/.stack/workers.json', 'utf8')) as {
  messageWorkerToken: string;
  noShowDepositWorkerToken: string;
  databaseChaosProbeToken: string;
};
const storage = JSON.parse(readFileSync('tests/e2e-live/.stack/storage.json', 'utf8')) as {
  real: boolean;
};
const functions = `${stack.gateway}/functions/v1`;
const primaryBucket = 'plateform-continuity-audit-archive';
const replicaBucket = 'plateform-continuity-audit-archive-replica';
// private.continuity_worker_runtime_config.worker_token for this test (fixture, 64 hex).
let continuityToken = '';

type Json = Record<string, unknown>;

async function call(name: string, body: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(`${functions}/${name}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Json };
}

// Headers of the continuity callers: anon JWT (no authority) plus the runtime worker token.
const continuityHeaders = (token: string) => ({
  authorization: `Bearer ${anonKey}`,
  apikey: anonKey,
  'x-plateform-worker-token': token,
});

async function rest(path: string, body: unknown, jwt = serviceKey) {
  const response = await fetch(`${stack.gateway}/rest/v1/${path}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${jwt}`,
      apikey: anonKey,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? (JSON.parse(text) as unknown) : null };
}

async function login(email: string): Promise<string> {
  const response = await fetch(`${stack.gateway}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: anonKey, 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  expect(response.status).toBe(200);
  const jwt = ((await response.json()) as { access_token: string }).access_token;
  // Same step as the staff app after sign-in: it opens the private.staff_sessions row that
  // private.real_role() requires.
  const session = await rest(
    'rpc/complete_staff_login',
    {
      p_device_name: 'e2e workers',
      p_platform: 'node',
      p_app_version: '0.1.0',
      p_device: null,
      p_device_token: randomBytes(32).toString('base64url'),
    },
    jwt,
  );
  expect(session.status, JSON.stringify(session.body)).toBe(200);
  return jwt;
}

test.beforeAll(async () => {
  // Deno compiles each function on first start: wait until every one answers (400 to `{}`-less POST).
  for (const name of [
    'reservation-message-worker',
    'reservation-deposit-no-show-worker',
    'continuity-retention-worker',
    'audit-archive-worker',
    'audit-archive-verify',
    'database-unavailable-chaos-probe',
  ])
    await expect
      .poll(async () => (await fetch(`${functions}/${name}`, { method: 'POST' })).status, {
        timeout: 90_000,
      })
      .not.toBe(502);
});

test.beforeEach(async () => {
  await reset();
  // Fixture: the per-installation runtime config that verify_continuity_worker_token checks.
  continuityToken = randomBytes(32).toString('hex');
  sql(`insert into private.continuity_worker_runtime_config(worker_token,function_url,function_anon_jwt,
      replica_target_url,replica_target_anon_jwt,replica_channel_token)
    values('${continuityToken}','https://e2e.invalid/functions/v1/continuity-worker','${anonKey}',
      'https://replica.e2e.invalid','${anonKey}','${randomBytes(32).toString('hex')}')`);
});

test('every worker fails closed without the right token (401, nothing claimed)', async () => {
  const wrong64 = randomBytes(32).toString('hex');
  const chaosResult = `select coalesce(max(executed_at)::text,'none') from private.release_test_results
    where key='DATABASE_UNAVAILABLE_CONTROLLED_CHAOS'`;
  const chaosBefore = sql(chaosResult);
  const cases: [string, unknown, string][] = [
    ['reservation-message-worker', { max_jobs: 20 }, 'x-plateform-worker-token'],
    ['reservation-deposit-no-show-worker', { max_jobs: 10 }, 'x-plateform-worker-token'],
    ['database-unavailable-chaos-probe', {}, 'x-plateform-chaos-token'],
    ['continuity-retention-worker', { source: 'cron', worker: 'RETENTION' }, ''],
    ['audit-archive-worker', { max_batches: 5 }, ''],
    ['audit-archive-verify', {}, ''],
  ];
  for (const [name, body, header] of cases) {
    const missing = header
      ? await call(name, body)
      : await call(name, body, { authorization: `Bearer ${anonKey}`, apikey: anonKey });
    expect(missing.status, `${name} without token`).toBe(401);
    expect(missing.body.code).toBe('UNAUTHORIZED');
    const wrong = header
      ? await call(name, body, { [header]: wrong64 })
      : await call(name, body, continuityHeaders(wrong64));
    expect(wrong.status, `${name} with a wrong token`).toBe(401);
  }
  // The service-role key is not a worker token either.
  expect(
    (
      await call(
        'reservation-message-worker',
        { max_jobs: 1 },
        { authorization: `Bearer ${serviceKey}` },
      )
    ).status,
  ).toBe(401);
  // Nothing ran on the way: no rate-limit bucket consumed, no verification or chaos result recorded.
  expect(
    sql(`select count(*) from private.rate_limits
      where bucket ~ '(worker|chaos|continuity|archive)'`),
  ).toBe('0');
  expect(sql(`select count(*) from private.audit_archive_verification_runs`)).toBe('0');
  expect(sql(chaosResult)).toBe(chaosBefore);
});

test('message worker claims and settles a real queued job through the MOCK adapter, then is IDLE', async () => {
  const token = { 'x-plateform-worker-token': workers.messageWorkerToken };
  // Empty queue first.
  const idle = await call('reservation-message-worker', { max_jobs: 20 }, token);
  expect(idle.status).toBe(200);
  expect(idle.body).toMatchObject({ mode: 'dry_run', claimed: 0, idle: true, claim_error: null });

  // Fixture: license messaging on this disposable installation (the licence grant flow is not
  // under test here), then configure it as the venue ADMIN through the real RPCs.
  sql(`update public.feature_flags set licensed=true
    where name in ('RESERVATION_MESSAGING','WHATSAPP_TELEGRAM_SMS_MESSAGING')`);
  const admin = await login(staff.admin.email);
  for (const name of ['RESERVATION_MESSAGING', 'WHATSAPP_TELEGRAM_SMS_MESSAGING']) {
    const saved = await rest(
      'rpc/save_venue_feature',
      { p_venue: ids.venue, p_name: name, p_enabled: true, p_version: null, p_key: randomUUID() },
      admin,
    );
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
  }
  for (const key of ['e2e_confirmation', 'e2e_reminder']) {
    const template = await rest(
      'rpc/save_message_template',
      {
        p_id: null,
        p_venue: ids.venue,
        p_channel: 'WHATSAPP',
        p_template_key: key,
        p_locale: 'it-IT',
        p_body_template:
          'Ciao {{customer_name}}, {{venue_name}} ti aspetta il {{reservation_date}} alle {{reservation_time}}.',
        p_provider_template_ref: null,
        p_active: true,
        p_version: null,
        p_key: randomUUID(),
      },
      admin,
    );
    expect(template.status, JSON.stringify(template.body)).toBe(200);
  }
  const setting = await rest(
    'rpc/save_message_provider_setting',
    {
      p_venue: ids.venue,
      p_channel: 'WHATSAPP',
      p_adapter: 'MOCK',
      p_enabled: true,
      p_sender_ref: null,
      p_confirmation_template: 'e2e_confirmation',
      p_reminder_template: 'e2e_reminder',
      p_max_attempts: 3,
      p_base_backoff_seconds: 30,
      p_max_backoff_seconds: 600,
      p_version: null,
      p_key: randomUUID(),
    },
    admin,
  );
  expect(setting.status, JSON.stringify(setting.body)).toBe(200);

  // A real reservation through create_public_reservation; its trigger writes the outbox event and
  // run_reservation_message_outbox (the cron step) turns it into a queued job.
  sql(`update public.venue_settings set reservations_enabled=true where venue_id='${ids.venue}'`);
  sql(`update public.restaurant_profile
    set public_content=coalesce(public_content,'{}'::jsonb)||'{"privacy_url":"https://trattoria-e2e.example/privacy"}'::jsonb`);
  const service = sql(`with s as (insert into public.services(venue_id,name,starts_at,ends_at)
      values('${ids.venue}','Cena','19:00','22:00') returning id,venue_id),
    r as (insert into public.service_booking_rules(venue_id,service_id,max_covers_service,max_arrivals_per_slot,max_covers_per_slot)
      select venue_id,id,40,4,12 from s)
    select id from s`);
  const tomorrow = sql(
    `select ((now() at time zone timezone)::date+1)::text from public.venues where id='${ids.venue}'`,
  );
  const booked = await rest('rpc/create_public_reservation', {
    p_venue: ids.venue,
    p_service: service,
    p_date: tomorrow,
    p_time: '20:00',
    p_first_name: 'Giulia',
    p_last_name: 'Verdi',
    p_phone: '+393331234567',
    p_party: 2,
    p_answers: {},
    p_key: randomUUID(),
    p_rate_key: randomBytes(32).toString('hex'),
  });
  expect(booked.status, JSON.stringify(booked.body)).toBe(200);
  const outbox = await rest('rpc/run_reservation_message_outbox', { p_limit: 10 });
  expect(outbox.body).toMatchObject({ processed_events: 1, jobs_created_or_reused: 1 });
  const job = sql(`select id from public.message_jobs where state='QUEUED'`);
  expect(job).toMatch(/^[0-9a-f-]{36}$/);

  const run = await call('reservation-message-worker', { max_jobs: 20 }, token);
  expect(run.status).toBe(200);
  expect(run.body).toMatchObject({
    mode: 'dry_run',
    claimed: 1,
    sent: 1,
    settle_errors: 0,
    idle: true,
    claim_error: null,
  });
  expect(
    sql(
      `select state||'|'||provider_message_id||'|'||attempts||'|'||(lease_token is null) from public.message_jobs where id='${job}'`,
    ),
  ).toBe(`SENT|mock:${job}|1|true`);

  const again = await call('reservation-message-worker', { max_jobs: 20 }, token);
  expect(again.body).toMatchObject({ claimed: 0, idle: true });
});

test('no-show deposit worker reports IDLE when no refund is due', async () => {
  const run = await call(
    'reservation-deposit-no-show-worker',
    { max_jobs: 10 },
    { 'x-plateform-worker-token': workers.noShowDepositWorkerToken },
  );
  expect(run.status).toBe(200);
  expect(run.body).toMatchObject({ status: 'IDLE', processed: 0, results: [] });
});

test('continuity retention worker reports the expired backlog and runs the alert reconciliation', async () => {
  const body = { source: 'cron', worker: 'RETENTION' };
  const empty = await call('continuity-retention-worker', body, continuityHeaders(continuityToken));
  expect(empty.status).toBe(200);
  expect(empty.body).toMatchObject({
    worker: 'RETENTION',
    status: 'IDLE',
    purge_performed_by: 'continuity-host',
    expired_unpurged: 0,
  });

  // Fixture: one successful backup whose retention expired two days ago and is not purged yet.
  // Its manifest/replica guards belong to the continuity host worker's own suite, so this row is
  // written with triggers off (disposable e2e database only).
  sql(`set session_replication_role=replica; insert into public.backup_metadata(status,purpose,started_at,completed_at,retention_until)
    values('SUCCEEDED','SCHEDULED',now()-interval '40 days',now()-interval '40 days',now()-interval '2 days')`);
  const overdue = await call(
    'continuity-retention-worker',
    body,
    continuityHeaders(continuityToken),
  );
  expect(overdue.status).toBe(200);
  expect(overdue.body).toMatchObject({ status: 'OVERDUE', expired_unpurged: 1, overdue: 1 });
  // Read-only: nothing claimed or purged by the Edge Function.
  expect(
    sql(
      `select count(*) from public.backup_metadata where purge_lease_token is not null or artifacts_purged_at is not null`,
    ),
  ).toBe('0');

  // The alerts step runs as service_role (20261020110000 made the wrapper owner-rights).
  expect(overdue.body.alerts).toMatchObject({ retention_overdue: 'OPENED' });
});

test('audit archive: seals a batch into real storage, verify records PASS, a tampered object FAIL', async () => {
  test.skip(
    !storage.real,
    'storage-api is not running (no Docker): archive objects need real storage',
  );
  const headers = continuityHeaders(continuityToken);
  // Fixture: audit rows old enough for the archive window (read_audit_archive_batch takes rows
  // older than 5 minutes).
  sql(`insert into public.audit_log(timestamp,actor_type,action,resource_type,operation,result,correlation_id,request_id)
    select now()-interval '10 minutes'-g*interval '1 second','SYSTEM','E2E_ARCHIVE_FIXTURE','e2e','INSERT','SUCCESS',
      gen_random_uuid(),gen_random_uuid()
    from generate_series(1,3) g`);
  const eligible = Number(
    sql(`select count(*) from public.audit_log where timestamp<now()-interval '5 minutes'`),
  );

  const sealed = await call('audit-archive-worker', { max_batches: 5 }, headers);
  expect(sealed.status, JSON.stringify(sealed.body)).toBe(200);
  expect(sealed.body).toMatchObject({
    status: 'OK',
    stopped: 'IDLE',
    batches_sealed: 1,
    last_batch: 1,
  });
  expect(sealed.body.rows_archived).toBe(eligible);
  const checkpoint = sql(
    `select object_path||'|'||chain_sha256 from private.audit_archive_batches where batch_no=1`,
  );
  const [path, chain] = checkpoint.split('|');
  expect(path).toBe('v1/batch-000000001.bin');
  expect(sealed.body.chain_sha256).toBe(chain);
  // Both private buckets hold the object in the real storage-api.
  expect(
    sql(`select string_agg(b.id||':'||b.public,',' order by b.id) from storage.buckets b
      join storage.objects o on o.bucket_id=b.id and o.name='${path}'`),
  ).toBe(`${primaryBucket}:false,${replicaBucket}:false`);

  const pass = await call('audit-archive-verify', {}, headers);
  expect(pass.status, JSON.stringify(pass.body)).toBe(200);
  expect(pass.body).toMatchObject({
    result: 'PASS',
    checked_batches: 1,
    checked_rows: eligible,
    final_chain_sha256: chain,
    failure_code: null,
  });
  expect(
    sql(`select result||'|'||checked_batches||'|'||coalesce(failure_code,'-')
      from private.audit_archive_verification_runs order by checked_at desc limit 1`),
  ).toBe('PASS|1|-');

  // Tamper with the primary copy through the storage API (one flipped byte).
  const objectUrl = `${stack.gateway}/storage/v1/object/${primaryBucket}/${path}`;
  const original = new Uint8Array(
    await (
      await fetch(objectUrl, { headers: { authorization: `Bearer ${serviceKey}` } })
    ).arrayBuffer(),
  );
  const tampered = original.slice();
  tampered[tampered.length - 1] = (tampered.at(-1) ?? 0) ^ 0xff;
  const upload = await fetch(objectUrl, {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${serviceKey}`,
      'content-type': 'application/octet-stream',
      'x-upsert': 'true',
    },
    body: tampered,
  });
  expect(upload.status).toBe(200);

  const fail = await call('audit-archive-verify', {}, headers);
  expect(fail.status).toBe(200);
  expect(fail.body).toMatchObject({
    result: 'FAIL',
    failure_code: 'ARCHIVE_PAYLOAD_HASH_MISMATCH',
  });
  expect(
    sql(`select result||'|'||failure_code from private.audit_archive_verification_runs
      order by checked_at desc limit 1`),
  ).toBe('FAIL|ARCHIVE_PAYLOAD_HASH_MISMATCH');
});

test('database-unavailable chaos probe records PASS through record_release_test_result', async () => {
  const run = await call(
    'database-unavailable-chaos-probe',
    {},
    { 'x-plateform-chaos-token': workers.databaseChaosProbeToken },
  );
  expect(run.status, JSON.stringify(run.body)).toBe(200);
  expect(run.body).toMatchObject({ key: 'DATABASE_UNAVAILABLE_CONTROLLED_CHAOS', status: 'PASS' });
  const evidence = run.body.evidence as Json;
  expect(evidence.chaos_error_code).toBe('CHAOS_DATABASE_TRANSPORT_UNAVAILABLE');
  expect(Object.values(evidence.checks as Json).every((value) => value === true)).toBe(true);
  expect(
    sql(`select status||'|'||executed_by||'|'||(evidence->>'probe_id')
      from private.release_test_results where key='DATABASE_UNAVAILABLE_CONTROLLED_CHAOS'`),
  ).toBe(`PASS|database-unavailable-chaos-probe|${String(evidence.probe_id)}`);
  // The sentinel row is gone.
  expect(
    sql(`select (public.read_database_chaos_probe('${String(evidence.probe_id)}')->>'exists')`),
  ).toBe('false');
});
