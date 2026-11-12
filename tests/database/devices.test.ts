import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { database, identity, ids, seed, sessionId } from './harness';

describe('Device registration and PIN boundaries', () => {
  let db: PGlite;
  const token = 'a'.repeat(43);
  beforeAll(async () => {
    db = await database();
    await seed(db);
  });
  beforeEach(async () => {
    await db.exec('begin');
  });
  afterEach(async () => {
    await db.exec('rollback; reset role');
  });
  afterAll(async () => {
    await db?.close();
  });

  async function freshSession() {
    await db.exec('reset role');
    await db.query('delete from private.staff_sessions where session_id=$1', [
      sessionId(ids.waiter),
    ]);
    await identity(db, ids.waiter);
  }
  async function login(device: string | null = null, secret = token) {
    return (
      await db.query<{ result: { device_id: string } }>(
        "select public.complete_staff_login('Tablet sala','Test','test',$1,$2) as result",
        [device, secret],
      )
    ).rows[0]!.result.device_id;
  }
  it('reuses a registered device on subsequent full logins without exhausting the device limit', async () => {
    await freshSession();
    const device = await login();
    await freshSession();
    expect(await login(device)).toBe(device);
    await db.exec('reset role');
    expect(
      (await db.query('select count(*)::integer as count from public.registered_devices')).rows,
    ).toEqual([{ count: 1 }]);
    const secrets = await db.query<{ token_hash: Uint8Array }>(
      'select token_hash from private.device_registration_secrets',
    );
    expect(secrets.rows[0]?.token_hash.length).toBe(32);
  });
  it('rejects a device ID without its matching registration token', async () => {
    await freshSession();
    const device = await login();
    await freshSession();
    await expect(login(device, 'b'.repeat(43))).rejects.toThrow('INVALID_DEVICE_TOKEN');
  });
  it('rejects a revoked device even with correct full credentials and registration token', async () => {
    await freshSession();
    const device = await login();
    await db.exec('reset role');
    await db.query('update public.registered_devices set revoked_at=now() where id=$1', [device]);
    await freshSession();
    await expect(login(device)).rejects.toThrow('DEVICE_REVOKED');
  });
  it('never accepts a null PIN and requires password after five failed attempts', async () => {
    await identity(db, ids.waiter);
    await db.query("select public.set_staff_pin('192847')");
    await db.query('select public.lock_staff_session()');
    for (let index = 0; index < 5; index++) {
      const result = await db.query<{ result: { ok: boolean; password_required: boolean } }>(
        'select public.unlock_staff_session(null) as result',
      );
      expect(result.rows[0]?.result).toEqual({ ok: false, password_required: index === 4 });
      await db.exec('reset role; update private.staff_pins set locked_until=null');
      await identity(db, ids.waiter);
    }
    expect(
      (await db.query("select public.unlock_staff_session('192847') as result")).rows[0],
    ).toMatchObject({ result: { ok: false, password_required: true } });
    expect(
      (await db.query('select public.get_auth_requirements() as result')).rows[0],
    ).toMatchObject({
      result: { session_unlocked: false, password_required: true, pin_enabled: true },
    });
  });
  it('requires full authentication again when the original password interval has expired', async () => {
    await identity(db, ids.waiter);
    await db.query("select public.set_staff_pin('192847')");
    await db.exec(
      "reset role; update private.staff_sessions set full_auth_at=now()-interval '3 hours',unlocked_until=now()-interval '1 hour'",
    );
    await identity(db, ids.waiter);
    expect(
      (await db.query("select public.unlock_staff_session('192847') as result")).rows[0],
    ).toMatchObject({ result: { ok: false, password_required: true } });
  });
  it('requires full login when MFA assurance is insufficient for the current role', async () => {
    await identity(db, ids.admin, 'aal1');
    expect(
      (await db.query('select public.get_auth_requirements() as result')).rows[0],
    ).toMatchObject({
      result: { session_unlocked: false, password_required: true, mfa_required: true },
    });
  });
});
