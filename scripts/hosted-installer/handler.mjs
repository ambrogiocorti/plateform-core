// A short-lived, fixed-plan staging installer. HTTP input never contains SQL,
// credentials, a target URL, migration content or an arbitrary query operation.
export const sha256 = async (text) =>
  Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');

const assert = (condition, code) => {
  if (!condition) throw new Error(code);
};
const constantTimeEqual = (a, b) => {
  let difference = a.length ^ b.length;
  for (let i = 0; i < 64; i++) difference |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return difference === 0;
};
const literal = (value) => `'${value.replaceAll("'", "''")}'`;
const lockID = '7285602261009001';

export function verifiedDatabaseURL(config, env, now) {
  assert(
    config.project_ref === 'kghactswtabakkkbojmo' &&
      /^[0-9a-f]{64}$/.test(config.token_sha256) &&
      Number.isSafeInteger(config.created_at_ms) &&
      Number.isSafeInteger(config.expires_at_ms) &&
      now >= config.created_at_ms &&
      config.expires_at_ms > now &&
      config.expires_at_ms - config.created_at_ms <= 60 * 60 * 1000 &&
      env.SUPABASE_URL === `https://${config.project_ref}.supabase.co`,
    'STAGING_INSTALL_CONTEXT_REJECTED',
  );
  let db;
  try {
    db = new URL(env.SUPABASE_DB_URL || 'invalid:');
  } catch {
    throw new Error('STAGING_INSTALL_CONTEXT_REJECTED');
  }
  assert(
    ['postgres:', 'postgresql:'].includes(db.protocol) &&
      db.hostname === `db.${config.project_ref}.supabase.co` &&
      ['5432', ''].includes(db.port) &&
      db.username === 'postgres' &&
      !!db.password &&
      db.pathname === '/postgres' &&
      !db.search &&
      !db.hash,
    'STAGING_INSTALL_CONTEXT_REJECTED',
  );
  return env.SUPABASE_DB_URL;
}

export async function verifyPayload(payload, config) {
  assert(
    payload.migrations.length === 458 &&
      new Set(payload.migrations.map((row) => row.version)).size === 458 &&
      payload.migrations.every(
        (row, i) =>
          /^\d{14}$/.test(row.version) &&
          /^[a-z0-9_]+$/.test(row.name) &&
          /^[0-9a-f]{64}$/.test(row.sha256) &&
          (i === 0 || payload.migrations[i - 1].version < row.version),
      ),
    'STAGING_INSTALL_PAYLOAD_REJECTED',
  );
  for (const key of ['bootstrap', 'postlude', 'barrier'])
    assert(
      (await sha256(payload[key])) === payload[`${key}_sha256`],
      'STAGING_INSTALL_PAYLOAD_REJECTED',
    );
  for (const row of payload.migrations)
    assert((await sha256(row.sql)) === row.sha256, 'STAGING_INSTALL_PAYLOAD_REJECTED');
  const inventory = await sha256(
    payload.migrations.map((row) => `${row.version}:${row.name}:${row.sha256}`).join('\n'),
  );
  assert(
    inventory === config.inventory_sha256 &&
      (await sha256(JSON.stringify(payload))) === config.payload_sha256,
    'STAGING_INSTALL_PAYLOAD_REJECTED',
  );
}

const ledgerQuery = `select version,name,array_to_string(statements,E'\\n') as sql
  from supabase_migrations.schema_migrations order by version`;

export async function verifiedPrefix(connection, payload) {
  const rows = await connection.query(ledgerQuery);
  assert(rows.length <= payload.migrations.length, 'STAGING_INSTALL_LEDGER_DRIFT');
  for (const [i, row] of rows.entries()) {
    const expected = payload.migrations[i];
    assert(
      row.version === expected.version && row.name === expected.name && row.sql === expected.sql,
      'STAGING_INSTALL_LEDGER_DRIFT',
    );
  }
  return rows.length;
}

async function requireEmptyData(connection) {
  const [row] = await connection.query(`select
    (select count(*)::int from auth.users) as users,
    (select count(*)::int from auth.sessions) as sessions,
    (select count(*)::int from storage.objects) as objects`);
  assert(
    row && row.users === 0 && row.sessions === 0 && row.objects === 0,
    'STAGING_INSTALL_DATA_NOT_EMPTY',
  );
}

async function requireBarrier(connection) {
  const [row] = await connection.query(`select
    exists(select 1 from pg_trigger where tgrelid='cron.job'::regclass
      and tgname='plateform_staging_cron_disarmed' and tgenabled='O'
      and tgfoid='plateform_installation.plateform_disarm_cron_job()'::regprocedure)
      as barrier,
    (select count(*)::int from cron.job where active) as active_jobs,
    (select count(*)::int from cron.job_run_details) as runs`);
  assert(
    row?.barrier && row.active_jobs === 0 && row.runs === 0,
    'STAGING_INSTALL_CRON_BARRIER_MISSING',
  );
}

export function createInstallerHandler({ config, payload, env, connect, now = Date.now }) {
  const response = (status, body) =>
    Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
  let payloadVerified;
  return async (request) => {
    // Authenticate and bind the target before constructing a database client.
    if (request.method !== 'POST') return response(405, { error: 'METHOD_NOT_ALLOWED' });
    const token = request.headers.get('x-plateform-install-token') || '';
    if (
      token.length < 40 ||
      token.length > 128 ||
      !constantTimeEqual(await sha256(token), config.token_sha256)
    )
      return response(401, { error: 'UNAUTHORIZED' });
    let databaseURL;
    try {
      databaseURL = verifiedDatabaseURL(config, env, now());
    } catch {
      return response(403, { error: 'STAGING_INSTALL_CONTEXT_REJECTED' });
    }
    let body;
    try {
      const raw = await request.text();
      if (raw.length > 100) throw new Error();
      body = JSON.parse(raw);
      assert(
        body &&
          Object.keys(body).length === 1 &&
          ['prepare', 'replay', 'finish'].includes(body.operation),
        'INVALID_OPERATION',
      );
    } catch {
      return response(400, { error: 'INVALID_OPERATION' });
    }
    let connection;
    let locked = false;
    let phase = body.operation;
    try {
      payloadVerified ||= verifyPayload(payload, config);
      await payloadVerified;
      connection = await connect(databaseURL);
      const [lock] = await connection.query(`select pg_try_advisory_lock(${lockID}) as acquired`);
      if (!lock?.acquired) return response(409, { error: 'STAGING_INSTALL_ALREADY_RUNNING' });
      locked = true;
      await requireEmptyData(connection);
      if (body.operation === 'prepare') {
        const [storage] = await connection.query(
          'select count(*)::int as buckets from storage.buckets',
        );
        assert(storage?.buckets === 0, 'STAGING_INSTALL_DATA_NOT_EMPTY');
        // Bootstrap refuses populated application schemas and any prior history.
        await connection.query(payload.bootstrap);
        await connection.query(`create schema if not exists supabase_migrations;
          create table if not exists supabase_migrations.schema_migrations(
            version text primary key,name text,statements text[]);`);
        await connection.query(payload.barrier);
        await requireBarrier(connection);
        return response(200, { prepared: true, project_ref: config.project_ref, migrations: 0 });
      }
      await requireBarrier(connection);
      const start = await verifiedPrefix(connection, payload);
      if (body.operation === 'replay') {
        const end = Math.min(start + 24, payload.migrations.length);
        for (const row of payload.migrations.slice(start, end)) {
          phase = row.filename;
          await connection.query(
            row.sql +
              '\n;\n' +
              `insert into supabase_migrations.schema_migrations(version,name,statements)
            values(${literal(row.version)},${literal(row.name)},array[${literal(row.sql)}]);`,
          );
        }
        await requireBarrier(connection);
        assert((await verifiedPrefix(connection, payload)) === end, 'STAGING_INSTALL_LEDGER_DRIFT');
        return response(200, {
          project_ref: config.project_ref,
          migrations: end,
          replay_complete: end === 458,
        });
      }
      assert(start === 458, 'STAGING_INSTALL_HISTORY_INCOMPLETE');
      await connection.query(payload.postlude);
      await requireBarrier(connection);
      const [gate] = await connection.query(`select
        (select count(*)::int from private.release_test_results where status='PASS') as test_pass,
        (select count(*)::int from private.release_gate_checks where status='PASS') as gate_pass,
        public.release_test_gate() as release_gate`);
      assert(
        gate.test_pass === 0 &&
          gate.gate_pass === 0 &&
          gate.release_gate.ok === false &&
          gate.release_gate.required_passed === 0,
        'STAGING_INSTALL_UNVERIFIED_RELEASE_CERTIFICATION',
      );
      return response(200, {
        classification: 'OBSERVED_HOSTED_INSTALL_NOT_COMMERCIAL_RELEASE_ATTESTATION',
        installed: true,
        project_ref: config.project_ref,
        migrations: start,
        inventory_sha256: config.inventory_sha256,
        source_commit: config.source_commit,
        payload_sha256: config.payload_sha256,
        cron_jobs_disarmed: true,
        test_pass: 0,
        gate_pass: 0,
        required_total: gate.release_gate.required_total,
        commercial_release_ready: false,
      });
    } catch (error) {
      // Never serialize driver errors: their fields may contain SQL/credentials.
      const code =
        typeof error?.message === 'string' && /^STAGING_INSTALL_[A-Z_]+$/.test(error.message)
          ? error.message
          : 'STAGING_INSTALL_DATABASE_ERROR';
      const sqlstate = /^[0-9A-Z]{5}$/.test(error?.code || '') ? error.code : null;
      return response(409, { error: code, sqlstate, phase });
    } finally {
      if (connection) {
        try {
          await connection.query('rollback');
        } catch {
          /* Fixed diagnostics only. */
        }
        if (locked) {
          try {
            await connection.query(`select pg_advisory_unlock(${lockID})`);
          } catch {
            /* Close below. */
          }
        }
        try {
          await connection.close();
        } catch {
          /* Never expose driver errors. */
        }
      }
    }
  };
}
