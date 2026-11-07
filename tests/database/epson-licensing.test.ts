import type { PGlite } from '@electric-sql/pglite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { database, identity, ids, seed } from './harness';

describe('licensed Epson printing and signed-bridge authorization', () => {
  let db: PGlite;
  beforeAll(async () => {
    db = await database();
    await seed(db);
  });
  beforeEach(async () => {
    await db.exec('reset role; begin');
  });
  afterEach(async () => {
    await db.exec('rollback; reset role');
  });
  afterAll(async () => {
    await db?.close();
  });

  async function printer(driver = 'BRIDGE') {
    await identity(db, ids.admin);
    return (
      await db.query<{ r: { id: string; version: number } }>(
        "select public.save_print_device(null,$1,null,'Epson',$2,'https://print.restaurant.test:7443/v1/print',array['CASHIER']::public.user_role[],true,$3) r",
        [ids.venue, driver, crypto.randomUUID()],
      )
    ).rows[0]!.r;
  }
  async function licensedPrinter() {
    await db.exec(
      "reset role; update public.feature_flags set licensed=true where name='EPSON_PRINTING'",
    );
    return printer();
  }
  async function queuedJob() {
    const device = await licensedPrinter();
    await db.exec('reset role');
    const job = crypto.randomUUID();
    await db.query(
      "insert into public.print_jobs(id,venue_id,print_device_id,kind,payload,requested_by,idempotency_key) values($1,$2,$3,'KITCHEN','{}',$4,$5)",
      [job, ids.venue, device.id, ids.cashier, crypto.randomUUID()],
    );
    await identity(db, ids.cashier);
    return { job, device: device.id };
  }

  it('defaults to external printing disabled', async () => {
    expect(
      (await db.query("select licensed from public.feature_flags where name='EPSON_PRINTING'"))
        .rows,
    ).toEqual([{ licensed: false }]);
  });
  it.each(['BRIDGE', 'EPOS'])(
    'refuses an unlicensed %s device through the staff RPC',
    async (driver) => {
      await expect(printer(driver)).rejects.toThrow('PRINT_DRIVER_NOT_INCLUDED');
    },
  );
  it('permits authorized printer setup once the installation is licensed', async () => {
    expect((await licensedPrinter()).id).toMatch(/^[a-f0-9-]{36}$/);
  });
  it('keeps the licensing helpers inaccessible to ordinary authenticated users', async () => {
    await identity(db, ids.admin);
    await expect(db.query('select private.external_printing_licensed()')).rejects.toThrow(
      'permission denied',
    );
  });
  it('never lets an ordinary Admin grant itself Epson printing', async () => {
    await identity(db, ids.admin);
    await expect(
      db.query("select public.configure_feature('EPSON_PRINTING',true,$1)", [crypto.randomUUID()]),
    ).rejects.toThrow('FORBIDDEN');
  });
  it('binds bridge authorization to the claimed job, lease, owner and exact endpoint', async () => {
    const { job, device } = await queuedJob();
    const lease = (
      await db.query<{ r: { job: { lease_token: string } } }>(
        'select public.claim_print_job($1) r',
        [job],
      )
    ).rows[0]!.r.job.lease_token;
    const authorization = (
      await db.query<{ r: Record<string, unknown> }>(
        'select public.get_print_bridge_authorization($1,$2) r',
        [job, lease],
      )
    ).rows[0]!.r;
    expect(authorization).toMatchObject({
      job_id: job,
      device_id: device,
      lease_id: lease,
      bridge_url: 'https://print.restaurant.test:7443/v1/print',
      staff_url: 'https://staff.restaurant.test',
    });
  });
  it('rejects a different signing lease', async () => {
    const { job } = await queuedJob();
    await db.query('select public.claim_print_job($1)', [job]);
    await expect(
      db.query('select public.get_print_bridge_authorization($1,$2)', [job, crypto.randomUUID()]),
    ).rejects.toThrow('LEASE_CONFLICT');
  });
  it('does not retry an external print with an unknown physical outcome', async () => {
    const { job } = await queuedJob();
    await db.query('select public.claim_print_job($1)', [job]);
    await expect(db.query('select public.claim_print_job($1)', [job])).rejects.toThrow(
      'PRINT_RECONCILIATION_REQUIRED',
    );
  });
  it('denies a role missing from the printer allowlist', async () => {
    const { job } = await queuedJob();
    await identity(db, ids.waiter);
    await expect(db.query('select public.claim_print_job($1)', [job])).rejects.toThrow(
      'PRINT_FORBIDDEN',
    );
  });
  it('blocks licence revocation while an external printer is active', async () => {
    await licensedPrinter();
    await db.exec('reset role');
    await expect(
      db.query("update public.feature_flags set licensed=false where name='EPSON_PRINTING'"),
    ).rejects.toThrow('PRINT_DEVICES_STILL_CONFIGURED');
  });
  it('prevents deactivating an external printer while jobs are still queued', async () => {
    const { device } = await queuedJob();
    await db.exec('reset role');
    await expect(
      db.query('update public.print_devices set active=false where id=$1', [device]),
    ).rejects.toThrow('PRINT_DEVICE_IN_USE');
  });
  it('allows a safe revocation after all devices and pending work are removed', async () => {
    const device = await licensedPrinter();
    await db.exec('reset role');
    await db.query('update public.print_devices set active=false where id=$1', [device.id]);
    await db.query("update public.feature_flags set licensed=false where name='EPSON_PRINTING'");
    expect(
      (await db.query("select licensed from public.feature_flags where name='EPSON_PRINTING'"))
        .rows,
    ).toEqual([{ licensed: false }]);
  });
});
