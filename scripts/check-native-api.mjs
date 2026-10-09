import { createHash, randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { createClient } from '@supabase/supabase-js';
import { nativeAssert as assert, nativeCIContext, nativeTOTP } from './native-ci-context.mjs';
import {
  nativeActors,
  nativeFixtureIDs,
  nativeFixtureSQL,
  nativeUUID,
} from './native-ci-fixtures.mjs';
import { cleanInstallPlan } from './clean-install-plan.mjs';
import { sourceDigest } from './check-release.mjs';

// Real Auth, JWT, PostgREST and Storage, confined to a verified disposable CI
// stack. These observations never create release PASS rows or certify hosted.
const checks = [];
let activeCheck = 'native_context';
const observe = async (key, fn) => {
  activeCheck = key;
  await fn();
  checks.push({ key, status: 'PASSED' });
  console.log(`Native API observed: ${key}`);
};
const accepted = (result, code) => {
  assert(!result.error, code);
  return result.data;
};
const deniedRPC = (result, message) =>
  assert(
    result.error?.code === '42501' && result.error.message === message,
    'NATIVE_API_EXPECTED_RPC_DENIAL',
  );
const deniedStorage = (result) =>
  assert(
    !!result.error &&
      [400, 401, 403, 404].includes(Number(result.error.status || result.error.statusCode)),
    'NATIVE_API_PRIVATE_STORAGE_EXPOSED',
  );
const claims = (token) =>
  JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
const bytesMatch = async (blob, expected) =>
  assert(
    !!blob && Buffer.from(await blob.arrayBuffer()).equals(expected),
    'NATIVE_API_STORAGE_BYTES_CHANGED',
  );

let context;
const report = {
  classification: 'OBSERVED_NATIVE_API_CI_NOT_COMMERCIAL_RELEASE_ATTESTATION',
  ok: false,
  checks,
  source_commit: process.env.GITHUB_SHA || null,
  workflow_run_id: process.env.GITHUB_RUN_ID || null,
  hosted_supabase_certified: false,
  commercial_release_ready: false,
  remaining: [
    'Hosted Auth/JWT/Storage and real browser/device flows',
    'Password recovery/email delivery',
    'Realtime, stock/payment concurrency and Edge HTTP',
    'Current-schema encrypted backup/restore',
    'Authenticated immutable release attestation ingestion',
  ],
};

try {
  context = await nativeCIContext();
  const { api, status, request, psql, json, platform } = context;
  const makeClient = (key = status.ANON_KEY) =>
    createClient(api.href, key, {
      auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
      global: { fetch: request },
    });
  const server = makeClient(status.SERVICE_ROLE_KEY);
  const anonymous = makeClient();
  const ids = nativeFixtureIDs();
  const actors = {};
  const session = async (actor) => {
    const data = accepted(await actor.client.auth.getSession(), 'NATIVE_API_SESSION_MISSING');
    assert(!!data.session, 'NATIVE_API_SESSION_MISSING');
    return data.session;
  };
  const visibleVenues = async (client, expected) => {
    const data = accepted(
      await client.from('venues').select('id').order('id'),
      'NATIVE_API_VENUE_READ_FAILED',
    );
    assert(
      JSON.stringify(data.map((row) => row.id)) === JSON.stringify([...expected].sort()),
      'NATIVE_API_VENUE_ISOLATION_FAILED',
    );
  };
  const register = async (actor) => {
    const data = accepted(
      await actor.client.rpc('complete_staff_login', actor.registration),
      'NATIVE_API_STAFF_REGISTRATION_FAILED',
    );
    actor.device = nativeUUID(data.device_id);
    return data;
  };
  const reserve = async (actor, bucket, venue, bytes, mime) => {
    const checksum = createHash('sha256').update(bytes).digest('hex');
    const args = {
      p_bucket: bucket,
      p_resource: null,
      p_venue: venue,
      p_size: bytes.length,
      p_mime: mime,
      p_checksum: checksum,
      p_key: crypto.randomUUID(),
    };
    const asset = accepted(
      await actor.client.rpc('reserve_asset_upload_command', args),
      'NATIVE_API_ASSET_RESERVATION_FAILED',
    );
    const repeat = accepted(
      await actor.client.rpc('reserve_asset_upload_command', args),
      'NATIVE_API_ASSET_RETRY_FAILED',
    );
    assert(
      repeat.id === asset.id && repeat.path === asset.path,
      'NATIVE_API_ASSET_RESERVATION_DUPLICATED',
    );
    nativeUUID(asset.id);
    assert(
      typeof asset.path === 'string' && asset.path.startsWith(`${venue}/`),
      'NATIVE_API_ASSET_PATH_INVALID',
    );
    accepted(
      await server.storage.from(bucket).upload(asset.path, bytes, { contentType: mime }),
      'NATIVE_API_SERVER_UPLOAD_FAILED',
    );
    accepted(
      await server.rpc('finish_asset_upload', {
        p_id: asset.id,
        p_success: true,
        p_checksum: checksum,
      }),
      'NATIVE_API_ASSET_FINALIZATION_FAILED',
    );
    return asset;
  };

  await observe('fresh_target_and_real_gotrue_identities', async () => {
    assert(
      (await psql(`select not exists(select 1 from public.restaurant_profile)
      and not exists(select 1 from public.staff_profiles)
      and not exists(select 1 from private.staff_sessions)`)) === 't',
      'NATIVE_API_FIXTURE_TARGET_NOT_EMPTY',
    );
    for (const fixture of nativeActors) {
      const actor = {
        ...fixture,
        email: `${fixture.name.toLowerCase()}@native-ci.invalid`,
        password: randomBytes(36).toString('base64url'),
        client: makeClient(),
        registration: {
          p_device_name: `Native ${fixture.name}`,
          p_platform: 'native-ci',
          p_app_version: 'ci',
          p_device: null,
          p_device_token: randomBytes(32).toString('base64url'),
        },
      };
      const result = accepted(
        await server.auth.admin.createUser({
          email: actor.email,
          password: actor.password,
          email_confirm: true,
        }),
        'NATIVE_API_USER_CREATE_FAILED',
      );
      actor.user = nativeUUID(result.user.id);
      actors[fixture.name] = actor;
    }
    await psql(
      nativeFixtureSQL(
        ids,
        Object.fromEntries(Object.entries(actors).map(([name, actor]) => [name, actor.user])),
      ),
    );
    assert(
      (await psql('select count(*) from private.staff_sessions')) === '0',
      'NATIVE_API_FORGED_STAFF_SESSIONS',
    );
    for (const actor of Object.values(actors)) {
      const data = accepted(
        await actor.client.auth.signInWithPassword({
          email: actor.email,
          password: actor.password,
        }),
        'NATIVE_API_PASSWORD_LOGIN_FAILED',
      );
      const jwt = claims(data.session.access_token);
      assert(
        jwt.sub === actor.user &&
          jwt.aal === 'aal1' &&
          jwt.amr.some((entry) => entry.method === 'password'),
        'NATIVE_API_PASSWORD_CLAIMS_INVALID',
      );
      nativeUUID(jwt.session_id);
      actor.sessionID = jwt.session_id;
      assert(
        accepted(await actor.client.auth.getUser(), 'NATIVE_API_SIGNED_USER_FAILED').user.id ===
          actor.user,
        'NATIVE_API_SIGNED_USER_MISMATCH',
      );
    }
    for (const actor of Object.values(actors)) await visibleVenues(actor.client, []);
  });

  await observe('mfa_required_aal1_denied_and_real_totp_aal2', async () => {
    for (const name of ['adminA', 'adminB', 'chainAdmin', 'superAdmin']) {
      const actor = actors[name];
      const requirements = accepted(
        await actor.client.rpc('get_auth_requirements'),
        'NATIVE_API_AUTH_REQUIREMENTS_FAILED',
      );
      assert(
        requirements.mfa_required &&
          requirements.role === actor.role &&
          !requirements.session_unlocked,
        'NATIVE_API_MFA_REQUIREMENT_MISSING',
      );
      deniedRPC(
        await actor.client.rpc('complete_staff_login', actor.registration),
        'LOGIN_FORBIDDEN',
      );
      const factor = accepted(
        await actor.client.auth.mfa.enroll({ factorType: 'totp', friendlyName: `Native ${name}` }),
        'NATIVE_API_TOTP_ENROLL_FAILED',
      );
      if (name === 'adminA') {
        const wrong = String((Number(nativeTOTP(factor.totp.secret)) + 1) % 1000000).padStart(
          6,
          '0',
        );
        const rejected = await actor.client.auth.mfa.challengeAndVerify({
          factorId: factor.id,
          code: wrong,
        });
        assert(
          !!rejected.error && Number(rejected.error.status) === 422,
          'NATIVE_API_WRONG_TOTP_ACCEPTED',
        );
        assert(
          claims((await session(actor)).access_token).aal === 'aal1',
          'NATIVE_API_WRONG_TOTP_ESCALATED',
        );
      }
      accepted(
        await actor.client.auth.mfa.challengeAndVerify({
          factorId: factor.id,
          code: nativeTOTP(factor.totp.secret),
        }),
        'NATIVE_API_TOTP_VERIFY_FAILED',
      );
      const jwt = claims((await session(actor)).access_token);
      assert(
        jwt.aal === 'aal2' && jwt.amr.some((entry) => entry.method === 'totp'),
        'NATIVE_API_TOTP_CLAIMS_INVALID',
      );
      actor.sessionID = nativeUUID(jwt.session_id);
      await register(actor);
    }
    await register(actors.waiterB);
  });

  await observe('concurrent_login_registers_one_device_per_session', async () => {
    const actor = actors.waiterA;
    const results = await Promise.all([register(actor), register(actor)]);
    assert(
      results[0].device_id === results[1].device_id,
      'NATIVE_API_CONCURRENT_DEVICE_DUPLICATED',
    );
    assert(
      (await psql(
        `select count(*) from public.registered_devices where user_id='${actor.user}'`,
      )) === '1',
      'NATIVE_API_CONCURRENT_DEVICE_DUPLICATED',
    );
    assert(
      (await psql(
        `select count(*) from private.staff_sessions where session_id='${actor.sessionID}'`,
      )) === '1',
      'NATIVE_API_CONCURRENT_SESSION_DUPLICATED',
    );
  });

  await observe('jwt_rls_scope_and_rpc_cross_venue_boundaries', async () => {
    for (const name of ['adminA', 'waiterA'])
      await visibleVenues(actors[name].client, [ids.venueA]);
    for (const name of ['adminB', 'waiterB'])
      await visibleVenues(actors[name].client, [ids.venueB]);
    for (const name of ['chainAdmin', 'superAdmin'])
      await visibleVenues(actors[name].client, [ids.venueA, ids.venueB]);
    await visibleVenues(actors.outsider.client, []);
    for (const [name, own, other, room] of [
      ['adminA', ids.venueA, ids.venueB, ids.roomA],
      ['waiterA', ids.venueA, ids.venueB, ids.roomA],
      ['adminB', ids.venueB, ids.venueA, ids.roomB],
      ['waiterB', ids.venueB, ids.venueA, ids.roomB],
    ]) {
      const actor = actors[name];
      const rooms = accepted(
        await actor.client.from('rooms').select('id,venue_id'),
        'NATIVE_API_ROOM_READ_FAILED',
      );
      assert(
        rooms.length === 1 && rooms[0].id === room && rooms[0].venue_id === own,
        'NATIVE_API_ROOM_ISOLATION_FAILED',
      );
      accepted(
        await actor.client.rpc('get_floor_workspace', { p_venue: own }),
        'NATIVE_API_OWN_VENUE_RPC_FAILED',
      );
      deniedRPC(
        await actor.client.rpc('get_floor_workspace', { p_venue: other }),
        'VENUE_FORBIDDEN',
      );
      deniedRPC(
        await actor.client.rpc('set_operational_venue', { p_venue: other }),
        'VENUE_FORBIDDEN',
      );
    }
    const context = accepted(
      await actors.waiterA.client.rpc('get_staff_venue_context'),
      'NATIVE_API_VENUE_CONTEXT_FAILED',
    );
    assert(
      context.authorized_venue_count === 1 &&
        context.auto_open &&
        !context.show_selector &&
        context.current_venue_id === ids.venueA,
      'NATIVE_API_SINGLE_ASSIGNMENT_CONTEXT_FAILED',
    );
    deniedRPC(
      await actors.outsider.client.rpc('complete_staff_login', actors.outsider.registration),
      'LOGIN_FORBIDDEN',
    );
  });

  await observe('editable_user_metadata_cannot_escalate_role_or_scope', async () => {
    const actor = actors.waiterA;
    accepted(
      await actor.client.auth.updateUser({
        data: { role: 'SUPER_ADMIN', scope: 'CHAIN', aal: 'aal2', venue_id: ids.venueB },
      }),
      'NATIVE_API_METADATA_UPDATE_FAILED',
    );
    accepted(await actor.client.auth.refreshSession(), 'NATIVE_API_METADATA_REFRESH_FAILED');
    const requirements = accepted(
      await actor.client.rpc('get_auth_requirements'),
      'NATIVE_API_AUTH_REQUIREMENTS_FAILED',
    );
    assert(
      requirements.role === 'WAITER' && !requirements.mfa_required,
      'NATIVE_API_USER_METADATA_ESCALATION',
    );
    await visibleVenues(actor.client, [ids.venueA]);
    deniedRPC(
      await actor.client.rpc('get_floor_workspace', { p_venue: ids.venueB }),
      'VENUE_FORBIDDEN',
    );
    const update = await actor.client
      .from('staff_profiles')
      .update({ role: 'SUPER_ADMIN', scope: 'CHAIN' })
      .eq('id', actor.user);
    assert(update.error?.code === '42501', 'NATIVE_API_DIRECT_ROLE_UPDATE_ACCEPTED');
    const args = {
      p_bucket: 'documents',
      p_resource: null,
      p_venue: ids.venueA,
      p_size: 20,
      p_mime: 'application/pdf',
      p_checksum: 'a'.repeat(64),
      p_key: crypto.randomUUID(),
    };
    deniedRPC(await actor.client.rpc('reserve_asset_upload_command', args), 'FORBIDDEN');
    deniedRPC(
      await actors.superAdmin.client.rpc('reserve_asset_upload_command', args),
      'FORBIDDEN',
    );
  });

  const pdfA = Buffer.from('%PDF-1.4\n% Native private document A\n%%EOF\n');
  const pdfB = Buffer.from('%PDF-1.4\n% Native private document B\n%%EOF\n');
  let documentA, documentB;
  await observe('private_storage_upload_download_and_venue_isolation', async () => {
    documentA = await reserve(actors.adminA, 'documents', ids.venueA, pdfA, 'application/pdf');
    documentB = await reserve(actors.adminB, 'documents', ids.venueB, pdfB, 'application/pdf');
    await bytesMatch(
      accepted(
        await actors.adminA.client.storage.from('documents').download(documentA.path),
        'NATIVE_API_OWN_DOCUMENT_DOWNLOAD_FAILED',
      ),
      pdfA,
    );
    await bytesMatch(
      accepted(
        await actors.adminB.client.storage.from('documents').download(documentB.path),
        'NATIVE_API_OWN_DOCUMENT_DOWNLOAD_FAILED',
      ),
      pdfB,
    );
    await bytesMatch(
      accepted(
        await actors.chainAdmin.client.storage.from('documents').download(documentA.path),
        'NATIVE_API_CHAIN_DOCUMENT_DOWNLOAD_FAILED',
      ),
      pdfA,
    );
    await bytesMatch(
      accepted(
        await actors.chainAdmin.client.storage.from('documents').download(documentB.path),
        'NATIVE_API_CHAIN_DOCUMENT_DOWNLOAD_FAILED',
      ),
      pdfB,
    );
    deniedStorage(await actors.adminA.client.storage.from('documents').download(documentB.path));
    deniedStorage(await actors.adminB.client.storage.from('documents').download(documentA.path));
    for (const actor of [actors.waiterA, actors.outsider, actors.superAdmin])
      deniedStorage(await actor.client.storage.from('documents').download(documentA.path));
    deniedStorage(await anonymous.storage.from('documents').download(documentA.path));
    deniedStorage(
      await actors.adminA.client.storage.from('documents').createSignedUrl(documentB.path, 60),
    );
    const response = await request(
      new URL(`/storage/v1/object/public/documents/${documentA.path}`, api),
      {
        headers: { apikey: status.ANON_KEY },
      },
    );
    assert(
      [400, 401, 403, 404].includes(response.status),
      'NATIVE_API_PUBLIC_PRIVATE_DOCUMENT_EXPOSED',
    );
  });

  await observe('storage_writes_require_server_and_bucket_mime_rules', async () => {
    for (const client of [actors.adminA.client, actors.waiterA.client, anonymous])
      deniedStorage(
        await client.storage
          .from('documents')
          .upload(`${ids.venueA}/unauthorized-${crypto.randomUUID()}.pdf`, pdfA, {
            contentType: 'application/pdf',
          }),
      );
    deniedStorage(
      await server.storage
        .from('documents')
        .upload(`${ids.venueA}/invalid-${crypto.randomUUID()}.txt`, Buffer.from('invalid'), {
          contentType: 'text/plain',
        }),
    );
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXioAAAAASUVORK5CYII=',
      'base64',
    );
    const image = await reserve(actors.adminA, 'gallery', ids.venueA, png, 'image/png');
    const response = await request(
      new URL(`/storage/v1/object/public/gallery/${image.path}`, api),
      { headers: { apikey: status.ANON_KEY } },
    );
    assert(
      response.ok && Buffer.from(await response.arrayBuffer()).equals(png),
      'NATIVE_API_PUBLIC_GALLERY_DOWNLOAD_FAILED',
    );
  });

  await observe('refresh_preserves_identity_and_operational_session', async () => {
    const actor = actors.waiterA;
    const before = await session(actor);
    const refreshed = accepted(
      await actor.client.auth.refreshSession(),
      'NATIVE_API_REFRESH_FAILED',
    );
    assert(
      claims(refreshed.session.access_token).session_id ===
        claims(before.access_token).session_id && refreshed.session.user.id === actor.user,
      'NATIVE_API_REFRESH_IDENTITY_CHANGED',
    );
    await visibleVenues(actor.client, [ids.venueA]);
  });

  await observe('pin_lock_cannot_be_bypassed_by_login_or_refresh', async () => {
    const actor = actors.waiterA;
    accepted(
      await actor.client.rpc('set_staff_pin', { p_pin: '291847' }),
      'NATIVE_API_PIN_SETUP_FAILED',
    );
    accepted(await actor.client.rpc('lock_staff_session'), 'NATIVE_API_LOCK_FAILED');
    await visibleVenues(actor.client, []);
    deniedRPC(await actor.client.rpc('get_floor_workspace', { p_venue: ids.venueA }), 'FORBIDDEN');
    deniedRPC(
      await actor.client.rpc('complete_staff_login', actor.registration),
      'PIN_OR_FULL_AUTH_REQUIRED',
    );
    accepted(await actor.client.auth.refreshSession(), 'NATIVE_API_LOCK_REFRESH_FAILED');
    await visibleVenues(actor.client, []);
    const unlocked = accepted(
      await actor.client.rpc('unlock_staff_session', { p_pin: '291847' }),
      'NATIVE_API_PIN_UNLOCK_FAILED',
    );
    assert(unlocked.ok, 'NATIVE_API_VALID_PIN_REJECTED');
    await visibleVenues(actor.client, [ids.venueA]);
  });

  await observe('operational_logout_revokes_old_and_refreshed_jwt', async () => {
    const actor = actors.waiterA;
    // A second real login for the same user demonstrates session-local scope.
    actor.secondClient = makeClient();
    accepted(
      await actor.secondClient.auth.signInWithPassword({
        email: actor.email,
        password: actor.password,
      }),
      'NATIVE_API_SECOND_SESSION_LOGIN_FAILED',
    );
    accepted(
      await actor.secondClient.rpc('complete_staff_login', {
        ...actor.registration,
        p_device_token: randomBytes(32).toString('base64url'),
      }),
      'NATIVE_API_SECOND_SESSION_REGISTRATION_FAILED',
    );
    const first = accepted(
      await actor.client.rpc('logout_staff_session'),
      'NATIVE_API_OPERATIONAL_LOGOUT_FAILED',
    );
    const second = accepted(
      await actor.client.rpc('logout_staff_session'),
      'NATIVE_API_REPEAT_LOGOUT_FAILED',
    );
    assert(
      first.ok && first.revoked && second.ok && second.already_inactive,
      'NATIVE_API_LOGOUT_NOT_IDEMPOTENT',
    );
    await visibleVenues(actor.client, []);
    accepted(await actor.client.auth.refreshSession(), 'NATIVE_API_LOGOUT_REFRESH_FAILED');
    await visibleVenues(actor.client, []);
    deniedRPC(
      await actor.client.rpc('complete_staff_login', actor.registration),
      'PIN_OR_FULL_AUTH_REQUIRED',
    );
    await visibleVenues(actor.secondClient, [ids.venueA]);
    assert(
      (await psql(`select exists(select 1 from public.audit_log
      where action='AUTH_LOGOUT' and actor_user_id='${actor.user}')`)) === 't',
      'NATIVE_API_LOGOUT_AUDIT_MISSING',
    );
  });

  await observe('gotrue_logout_invalidates_refresh_and_stale_jwt_access', async () => {
    const actor = actors.waiterA;
    const previous = await session(actor);
    accepted(
      await actor.client.auth.signOut({ scope: 'local' }),
      'NATIVE_API_GOTRUE_LOGOUT_FAILED',
    );
    assert(
      (await psql(
        `select not exists(select 1 from auth.sessions where id='${actor.sessionID}')`,
      )) === 't',
      'NATIVE_API_GOTRUE_SESSION_NOT_REMOVED',
    );
    const response = await request(new URL('/rest/v1/venues?select=id', api), {
      headers: {
        apikey: status.ANON_KEY,
        Authorization: `Bearer ${previous.access_token}`,
      },
    });
    assert(
      response.ok && JSON.stringify(await response.json()) === '[]',
      'NATIVE_API_STALE_JWT_RETAINED_SCOPE',
    );
    const refreshed = await makeClient().auth.refreshSession({
      refresh_token: previous.refresh_token,
    });
    assert(
      !!refreshed.error && [400, 401, 403].includes(Number(refreshed.error.status)),
      'NATIVE_API_REVOKED_REFRESH_ACCEPTED',
    );
    await visibleVenues(actor.secondClient, [ids.venueA]);
  });

  await observe('live_assignment_removal_immediately_denies_http_and_storage', async () => {
    const actor = actors.adminB;
    await psql(`update public.staff_venue_assignments set active=false
      where user_id='${actor.user}' and venue_id='${ids.venueB}'`);
    await visibleVenues(actor.client, []);
    deniedRPC(
      await actor.client.rpc('get_floor_workspace', { p_venue: ids.venueB }),
      'VENUE_FORBIDDEN',
    );
    deniedStorage(await actor.client.storage.from('documents').download(documentB.path));
  });

  await observe('live_device_revocation_denies_http_storage_and_relogin', async () => {
    const actor = actors.adminA;
    // Inject administrative revocation as fixture DATA, without pretending to
    // exercise the separate privileged staff-admin/step-up Edge workflow.
    await psql(
      `update public.registered_devices set revoked_at=clock_timestamp() where id='${actor.device}'`,
    );
    await visibleVenues(actor.client, []);
    deniedRPC(await actor.client.rpc('get_floor_workspace', { p_venue: ids.venueA }), 'FORBIDDEN');
    deniedStorage(await actor.client.storage.from('documents').download(documentA.path));
    deniedRPC(await actor.client.rpc('complete_staff_login', actor.registration), 'DEVICE_REVOKED');
    accepted(await actor.client.auth.refreshSession(), 'NATIVE_API_DEVICE_REVOKED_REFRESH_FAILED');
    await visibleVenues(actor.client, []);
    deniedStorage(await actor.client.storage.from('documents').download(documentA.path));
  });

  await observe('live_staff_deactivation_immediately_denies_old_jwt', async () => {
    const actor = actors.waiterB;
    await psql(`update public.staff_profiles set active=false where id='${actor.user}'`);
    await visibleVenues(actor.client, []);
    deniedRPC(await actor.client.rpc('get_floor_workspace', { p_venue: ids.venueB }), 'FORBIDDEN');
    deniedRPC(
      await actor.client.rpc('complete_staff_login', actor.registration),
      'LOGIN_FORBIDDEN',
    );
  });

  const plan = await cleanInstallPlan();
  await observe('probes_leave_schema_ledger_and_release_certification_unchanged', async () => {
    const ledger = await json(`select json_agg(x order by x.version) from (
      select version,name,encode(extensions.digest(array_to_string(statements,E'\\n'),'sha256'),'hex') as sha256
      from supabase_migrations.schema_migrations) x`);
    assert(
      JSON.stringify(ledger) ===
        JSON.stringify(
          plan.migrations.map(({ version, name, sha256 }) => ({ version, name, sha256 })),
        ),
      'NATIVE_API_PROBES_CHANGED_MIGRATION_LEDGER',
    );
    assert(
      (await psql(`select not exists(select 1 from private.release_test_results where status='PASS')
      and not exists(select 1 from private.release_gate_checks where status='PASS')
      and not (public.release_test_gate()->>'ok')::boolean`)) === 't',
      'NATIVE_API_PROBES_CERTIFIED_RELEASE',
    );
    assert((await psql('show cron.launch_active_jobs')) === 'off', 'NATIVE_API_CRON_ENABLED');
  });
  Object.assign(report, {
    ok: true,
    platform,
    source_digest: await sourceDigest(),
    inventory_sha256: plan.inventorySha256,
    bootstrap_sha256: plan.bootstrapManifest.bootstrap_sha256,
    postlude_sha256: plan.bootstrapManifest.postlude_sha256,
    checks_passed: checks.length,
    fixture: { gotrue_identities: nativeActors.length, active_venues: 2, forged_auth_sessions: 0 },
    network: { loopback_only: true, verified_egress_block: true, redirects_denied: true },
  });
} catch (error) {
  // No auth responses, SQL, JWTs, passwords, refresh/device tokens or TOTP
  // secrets are included in failure reports, even when an SDK throws them.
  report.failure = {
    check: activeCheck,
    code: /^[A-Z][A-Z0-9_:]+$/.test(error.message || '')
      ? error.message
      : 'NATIVE_API_UNEXPECTED_FAILURE',
  };
  process.exitCode = 1;
}
if (context) {
  const output = JSON.stringify(report, null, 2) + '\n';
  await writeFile('.local/native-ci/api-verification.json', output, { mode: 0o600 });
  console.log(
    JSON.stringify({ ...report, report_sha256: createHash('sha256').update(output).digest('hex') }),
  );
} else {
  console.error(`NATIVE_API_FAILED:${report.failure?.code || 'NATIVE_API_CONTEXT_FAILED'}`);
}
