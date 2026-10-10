import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

const VENUE_A = '51000000-0000-4000-8000-000000000001';
const VENUE_B = '51000000-0000-4000-8000-000000000002';
const ROOM_A = '52000000-0000-4000-8000-000000000001';
const ROOM_B = '52000000-0000-4000-8000-000000000002';
const PASSWORD = 'CI-Only-Supabase-Testing-Secret-2026!';

function command(binary, args, options = {}) {
  const result = spawnSync(binary, args, {
    encoding: 'utf8',
    timeout: 150_000,
    maxBuffer: 5 * 1024 * 1024,
    ...options,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`LOCAL_HTTP_FIXTURE_COMMAND_FAILED:${binary}`);
  }
  return result.stdout.trim();
}

function localStatus() {
  const response = command('supabase', ['status', '-o', 'json']);
  let data;
  try {
    data = JSON.parse(response);
  } catch {
    throw new Error('LOCAL_SUPABASE_STATUS_INVALID');
  }
  const api = data.API_URL ?? data.api_url;
  const anonKey = data.ANON_KEY ?? data.anon_key;
  const serviceKey = data.SERVICE_ROLE_KEY ?? data.service_role_key;
  if (!api || !anonKey || !serviceKey) {
    throw new Error('LOCAL_SUPABASE_AUTH_KEYS_MISSING');
  }
  const url = new URL(api);
  if (!['127.0.0.1', 'localhost'].includes(url.hostname)) {
    throw new Error('LOCAL_SUPABASE_EXPECTED_LOOPBACK_ONLY');
  }
  return { api: url.origin, anonKey, serviceKey };
}

function postgres(sql) {
  const containers = command('docker', [
    'ps',
    '--filter',
    'name=supabase_db_',
    '--format',
    '{{.Names}}',
  ])
    .split('\n')
    .filter(Boolean);
  if (containers.length !== 1) throw new Error('EXPECTED_SINGLE_DISPOSABLE_DB');
  command('docker', [
    'exec',
    containers[0],
    'psql',
    '--username',
    'postgres',
    '--dbname',
    'postgres',
    '--no-psqlrc',
    '--set',
    'ON_ERROR_STOP=1',
    '--command',
    sql,
  ]);
}

function uuid(input) {
  assert.match(input, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  return input;
}

async function createIdentity(supabase, email) {
  const { data: created, error } = await supabase.auth.admin.createUser({
    email,
    password: PASSWORD,
    email_confirm: true,
  });
  if (error || !created?.user?.id) throw new Error('LOCAL_AUTH_USER_CREATION_FAILED');
  uuid(created.user.id);
  return created.user.id;
}

function base32Decode(secret) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let remaining = 0;
  const bytes = [];
  for (const letter of secret.toUpperCase().replaceAll(/[^A-Z2-7]/g, '')) {
    const digit = alphabet.indexOf(letter);
    if (digit < 0) throw new Error('LOCAL_TOTP_SECRET_INVALID');
    bits = (bits << 5) | digit;
    remaining += 5;
    if (remaining >= 8) {
      remaining -= 8;
      bytes.push((bits >> remaining) & 255);
      bits &= (1 << remaining) - 1;
    }
  }
  if (bytes.length < 10) throw new Error('LOCAL_TOTP_SECRET_INVALID');
  return Buffer.from(bytes);
}

function totp(secret) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const digest = createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const offset = digest[digest.length - 1] & 15;
  const value =
    ((digest[offset] & 127) << 24) |
    ((digest[offset + 1] & 255) << 16) |
    ((digest[offset + 2] & 255) << 8) |
    (digest[offset + 3] & 255);
  return String(value % 1_000_000).padStart(6, '0');
}

function jwtClaims(token) {
  try {
    return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
  } catch {
    throw new Error('LOCAL_JWT_CLAIMS_INVALID');
  }
}

async function signIn(api, anonKey, email) {
  const client = createClient(api, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await client.auth.signInWithPassword({
    email,
    password: PASSWORD,
  });
  if (error || !data?.session?.access_token || !data.session.user) {
    throw new Error('LOCAL_AUTH_LOGIN_FAILED');
  }
  const lowToken = data.session.access_token;
  assert.equal(jwtClaims(lowToken).aal, 'aal1', 'password-only session is AAL1');
  const enrolled = await client.auth.mfa.enroll({
    factorType: 'totp',
    friendlyName: 'Isolated CI TOTP',
  });
  if (enrolled.error || !enrolled.data?.id || !enrolled.data.totp?.secret) {
    throw new Error('LOCAL_TOTP_ENROLL_FAILED');
  }
  const challenge = await client.auth.mfa.challenge({ factorId: enrolled.data.id });
  if (challenge.error || !challenge.data?.id) {
    throw new Error('LOCAL_TOTP_CHALLENGE_FAILED');
  }
  const verified = await client.auth.mfa.verify({
    factorId: enrolled.data.id,
    challengeId: challenge.data.id,
    code: totp(enrolled.data.totp.secret),
  });
  if (verified.error) throw new Error('LOCAL_TOTP_VERIFY_FAILED');
  const latest = await client.auth.getSession();
  if (latest.error || !latest.data.session?.access_token) {
    throw new Error('LOCAL_AAL2_SESSION_MISSING');
  }
  assert.equal(jwtClaims(latest.data.session.access_token).aal, 'aal2');
  return { session: latest.data.session, lowToken };
}

async function rest(api, anonKey, token, path, method = 'GET', body = undefined) {
  const res = await fetch(`${api}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: anonKey,
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      ...(body === undefined
        ? {}
        : {
            'Content-Type': 'application/json',
            Prefer: 'return=representation',
          }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const content = await res.text();
  let parsed;
  try {
    parsed = content ? JSON.parse(content) : null;
  } catch {
    throw new Error('LOCAL_REST_UNEXPECTED_NON_JSON');
  }
  return { status: res.status, parsed };
}

function exactly(rows, ids) {
  assert.deepEqual((rows ?? []).map((x) => x.id).sort(), ids.slice().sort());
}

async function run() {
  const { api, anonKey, serviceKey } = localStatus();
  const root = createClient(api, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const userA = await createIdentity(root, 'isolated.admin.a@example.test');
  const userB = await createIdentity(root, 'isolated.admin.b@example.test');
  const loginA = await signIn(api, anonKey, 'isolated.admin.a@example.test');
  const loginB = await signIn(api, anonKey, 'isolated.admin.b@example.test');
  const sessionA = loginA.session;
  const sessionB = loginB.session;
  const sessionAId = uuid(
    sessionA.access_token
      ? JSON.parse(Buffer.from(sessionA.access_token.split('.')[1], 'base64url').toString('utf8'))
          .session_id
      : '',
  );
  const sessionBId = uuid(
    JSON.parse(Buffer.from(sessionB.access_token.split('.')[1], 'base64url').toString('utf8'))
      .session_id,
  );

  postgres(`
    begin;
    insert into public.restaurant_profile(name,public_base_url,staff_base_url,staff_identity_domain)
      values ('Local HTTP fixture', 'https://restaurant.test','https://staff.test','staff.test');
    insert into public.restaurant_settings(id) values (true);
    insert into public.system_limits(id) values (true);
    update public.feature_flags set licensed = true where name = 'MULTI_VENUE';
    insert into public.venues(id,name,slug,code,address,phone) values
      ('${VENUE_A}', 'Venue A', 'venue-a', 'VA', 'A', '+390000000001'),
      ('${VENUE_B}', 'Venue B', 'venue-b', 'VB', 'B', '+390000000002');
    insert into public.venue_settings(venue_id) values
      ('${VENUE_A}'), ('${VENUE_B}');
    insert into public.staff_profiles(id,display_name,role,scope) values
      ('${userA}', 'Admin A', 'ADMIN','VENUE'),
      ('${userB}', 'Admin B', 'ADMIN','VENUE');
    insert into public.staff_venue_assignments(user_id,venue_id) values
      ('${userA}', '${VENUE_A}'), ('${userB}', '${VENUE_B}');
    insert into private.staff_sessions(session_id,user_id,full_auth_at,unlocked_until)
      values ('${sessionAId}','${userA}',now(),now()+interval '2 hours'),
             ('${sessionBId}','${userB}',now(),now()+interval '2 hours')
      on conflict (session_id) do update
        set full_auth_at = excluded.full_auth_at, unlocked_until = excluded.unlocked_until;
    insert into public.rooms(id,venue_id,name) values
      ('${ROOM_A}', '${VENUE_A}', 'Room A'),
      ('${ROOM_B}', '${VENUE_B}', 'Room B');
    commit;
  `);

  const passwordOnly = await rest(api, anonKey, loginA.lowToken, 'venues?select=id');
  assert.ok([200, 401, 403].includes(passwordOnly.status));
  if (passwordOnly.status === 200) exactly(passwordOnly.parsed, []);
  console.log('JWT_HTTP_PASSWORD_ONLY_NOT_FULLY_AUTHORIZED=PASSED');

  // End-to-end: real GoTrue sessions -> Kong/PostgREST -> PostgreSQL RLS.
  for (const [token, ownVenue, ownRoom] of [
    [sessionA.access_token, VENUE_A, ROOM_A],
    [sessionB.access_token, VENUE_B, ROOM_B],
  ]) {
    const venues = await rest(api, anonKey, token, 'venues?select=id&order=id');
    assert.equal(venues.status, 200, 'JWT can query its own venue');
    exactly(venues.parsed, [ownVenue]);
    const rooms = await rest(api, anonKey, token, 'rooms?select=id&order=id');
    assert.equal(rooms.status, 200, 'JWT can query its own room');
    exactly(rooms.parsed, [ownRoom]);
  }
  console.log('JWT_HTTP_VENUE_READ_ISOLATION=PASSED');

  const mutation = await rest(
    api,
    anonKey,
    sessionA.access_token,
    `rooms?id=eq.${ROOM_B}`,
    'PATCH',
    { name: 'CROSS_TENANT_MUTATION' },
  );
  assert.ok([200, 204, 401, 403].includes(mutation.status), 'unexpected mutation response');
  if (mutation.status === 200) exactly(mutation.parsed, []);
  const after = await rest(
    api,
    anonKey,
    sessionB.access_token,
    `rooms?id=eq.${ROOM_B}&select=name`,
  );
  assert.equal(after.status, 200);
  assert.deepEqual(after.parsed, [{ name: 'Room B' }]);
  console.log('JWT_HTTP_CROSS_VENUE_MUTATION_DENIED=PASSED');

  const rpc = await rest(api, anonKey, sessionA.access_token, 'rpc/get_floor_workspace', 'POST', {
    p_venue: VENUE_B,
  });
  assert.ok(rpc.status >= 400, 'cross-venue privileged RPC must fail');
  assert.match(JSON.stringify(rpc.parsed), /VENUE_FORBIDDEN/);
  console.log('JWT_HTTP_CROSS_VENUE_RPC_DENIED=PASSED');

  postgres(`update public.staff_venue_assignments
    set active = false where user_id = '${userA}' and venue_id = '${VENUE_A}';`);
  const afterRevoke = await rest(api, anonKey, sessionA.access_token, 'rooms?select=id');
  assert.equal(afterRevoke.status, 200);
  exactly(afterRevoke.parsed, []);
  console.log('JWT_HTTP_ASSIGNMENT_REVOCATION_WITH_SAME_TOKEN=PASSED');
  console.log('LOCAL_AUTH_POSTGREST_CROSS_VENUE_GATE=PASSED');
}

await run().catch((err) => {
  // Never print access tokens, service-role key or SQL fixture secrets.
  console.error('LOCAL_AUTH_POSTGREST_CROSS_VENUE_GATE=BLOCKED', err.message);
  process.exitCode = 1;
});
