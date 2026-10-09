import { beforeAll, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { cleanInstallPlan } from '../../scripts/clean-install-plan.mjs';
import {
  createInstallerHandler,
  sha256,
  verifyPayload,
  verifiedDatabaseURL,
  verifiedPrefix,
  type InstallerConfig,
  type InstallerConnection,
  type InstallerPayload,
} from '../../scripts/hosted-installer/handler.mjs';

const clock = Date.parse('2026-10-09T12:00:00Z');
const token = 'fixed-unit-test-token-which-is-not-a-deployed-credential';
const target = 'kghactswtabakkkbojmo';
const env = {
  SUPABASE_URL: `https://${target}.supabase.co`,
  SUPABASE_DB_URL: `postgresql://postgres:unit-test-placeholder@db.${target}.supabase.co:5432/postgres`,
};
let config: InstallerConfig;
let payload: InstallerPayload;
beforeAll(async () => {
  const plan = await cleanInstallPlan();
  const barrier = await readFile('supabase/clean-install/disarm-cron.sql', 'utf8');
  payload = {
    bootstrap: plan.bootstrap,
    bootstrap_sha256: await sha256(plan.bootstrap),
    postlude: plan.postlude,
    postlude_sha256: await sha256(plan.postlude),
    barrier,
    barrier_sha256: await sha256(barrier),
    migrations: plan.migrations,
  };
  config = {
    project_ref: target,
    token_sha256: await sha256(token),
    created_at_ms: clock,
    expires_at_ms: clock + 3600000,
    inventory_sha256: plan.inventorySha256,
    payload_sha256: await sha256(JSON.stringify(payload)),
    source_commit: 'f'.repeat(40),
  };
});
const request = (body: unknown = { operation: 'replay' }, credential = token) =>
  new Request(`https://${target}.supabase.co/functions/v1/plateform-staging-installer`, {
    method: 'POST',
    headers: { 'x-plateform-install-token': credential },
    body: JSON.stringify(body),
  });
const connection = (): InstallerConnection => ({
  query: vi.fn(async () => []),
  close: vi.fn(async () => {}),
});

describe('temporary staging installer boundary', () => {
  it('refuses missing/wrong credentials before constructing a database client', async () => {
    const connect = vi.fn(async () => connection());
    const handler = createInstallerHandler({ config, payload, env, connect, now: () => clock });
    for (const credential of ['', 'x'.repeat(64), token + 'extra'])
      expect((await handler(request(undefined, credential))).status).toBe(401);
    expect(connect).not.toHaveBeenCalled();
  });

  it('refuses expired authorization and refuses a lifetime longer than one hour', async () => {
    const connect = vi.fn(async () => connection());
    const handler = createInstallerHandler({
      config,
      payload,
      env,
      connect,
      now: () => clock + 3600000,
    });
    expect((await handler(request())).status).toBe(403);
    expect(connect).not.toHaveBeenCalled();
    expect(() =>
      verifiedDatabaseURL({ ...config, expires_at_ms: clock + 3600001 }, env, clock),
    ).toThrow();
  });

  it('binds API, database hostname, role, port and database to the authorized staging', () => {
    for (const url of [
      env.SUPABASE_DB_URL.replace(target, 'abdxvlykasqmknexxhjo'),
      env.SUPABASE_DB_URL.replace(':5432/', ':6543/'),
      env.SUPABASE_DB_URL.replace('/postgres', '/other'),
      env.SUPABASE_DB_URL + '?hostaddr=127.0.0.1',
      env.SUPABASE_DB_URL.replace('postgres:', 'supabase_admin:'),
      'postgresql://postgres:fixture@db.kghactswtabakkkbojmo.supabase.co.attacker.invalid:5432/postgres',
    ])
      expect(() => verifiedDatabaseURL(config, { ...env, SUPABASE_DB_URL: url }, clock)).toThrow();
    expect(() =>
      verifiedDatabaseURL(config, { ...env, SUPABASE_URL: 'https://other.supabase.co' }, clock),
    ).toThrow();
    expect(verifiedDatabaseURL(config, env, clock)).toBe(env.SUPABASE_DB_URL);
  });

  it('rejects HTTP-supplied SQL, target overrides and unknown operations without database access', async () => {
    const connect = vi.fn(async () => connection());
    const handler = createInstallerHandler({ config, payload, env, connect, now: () => clock });
    for (const body of [
      { operation: 'replay', sql: 'select 1' },
      { operation: 'execute' },
      { operation: 'prepare', project_ref: 'abdxvlykasqmknexxhjo' },
      null,
    ])
      expect((await handler(request(body))).status).toBe(400);
    expect(connect).not.toHaveBeenCalled();
  });

  it('verifies the entire fixed payload and refuses changed historical SQL before connecting', async () => {
    await expect(verifyPayload(payload, config)).resolves.toBeUndefined();
    const corrupted = {
      ...payload,
      migrations: payload.migrations.map((row, i) =>
        i === 12 ? { ...row, sql: row.sql + '\nselect 1;' } : row,
      ),
    };
    const connect = vi.fn(async () => connection());
    const handler = createInstallerHandler({
      config,
      payload: corrupted,
      env,
      connect,
      now: () => clock,
    });
    expect((await handler(request())).status).toBe(409);
    expect(connect).not.toHaveBeenCalled();
  });

  it('rejects a changed ledger prefix rather than replaying over it', async () => {
    const first = payload.migrations[0]!;
    await expect(
      verifiedPrefix(
        {
          ...connection(),
          query: async () => [
            { version: first.version, name: first.name, sql: first.sql + '\n-- changed' },
          ],
        },
        payload,
      ),
    ).rejects.toThrow('STAGING_INSTALL_LEDGER_DRIFT');
  });

  it('refuses a second concurrent installer and releases its connection without writes', async () => {
    const db = connection();
    db.query = vi.fn(async () => [{ acquired: false }]);
    const handler = createInstallerHandler({
      config,
      payload,
      env,
      connect: async () => db,
      now: () => clock,
    });
    expect((await handler(request())).status).toBe(409);
    expect(db.close).toHaveBeenCalledOnce();
    expect(vi.mocked(db.query).mock.calls.some(([sql]) => sql.includes('insert into'))).toBe(false);
  });

  it('redacts driver errors, rolls back and unlocks after a failure', async () => {
    const db = connection();
    db.query = vi.fn(async (sql) => {
      if (sql.includes('pg_try_advisory_lock')) return [{ acquired: true }];
      if (sql.startsWith('select\n'))
        throw Object.assign(new Error('postgresql://postgres:LEAK@host/private-data'), {
          code: '08006',
        });
      return [];
    });
    const handler = createInstallerHandler({
      config,
      payload,
      env,
      connect: async () => db,
      now: () => clock,
    });
    const result = await handler(request());
    expect(await result.json()).toEqual({
      error: 'STAGING_INSTALL_DATABASE_ERROR',
      sqlstate: '08006',
      phase: 'replay',
    });
    expect(db.close).toHaveBeenCalledOnce();
    expect(vi.mocked(db.query).mock.calls.some(([sql]) => sql === 'rollback')).toBe(true);
    expect(vi.mocked(db.query).mock.calls.some(([sql]) => sql.includes('pg_advisory_unlock'))).toBe(
      true,
    );
  });
});
