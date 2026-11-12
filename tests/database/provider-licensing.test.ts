import type { PGlite } from '@electric-sql/pglite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { database, identity, ids, seed, sessionId } from './harness';

describe('current provider licensing and booking-deposit dependencies', () => {
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

  async function grant(capability: string, licensed = true) {
    await db.exec('reset role');
    const proof = crypto.randomUUID();
    await db.query(
      "insert into private.step_up_grants(id,user_id,session_id,action,expires_at) values($1,$2,$3,'FEATURE_CHANGE',now()+interval '1 minute')",
      [proof, ids.superAdmin, sessionId(ids.superAdmin)],
    );
    await identity(db, ids.superAdmin);
    await db.query('select public.configure_feature($1,$2,$3)', [capability, licensed, proof]);
  }

  it('starts with all external providers and deposits unlicensed', async () => {
    const result = await db.query<{ name: string; licensed: boolean }>(
      "select name,licensed from public.feature_flags where name in ('STRIPE','SATISPAY_API','BOOKING_DEPOSITS') order by name",
    );
    expect(result.rows).toEqual([
      { name: 'BOOKING_DEPOSITS', licensed: false },
      { name: 'SATISPAY_API', licensed: false },
      { name: 'STRIPE', licensed: false },
    ]);
  });
  it.each(['STRIPE', 'SATISPAY_API', 'EPSON_PRINTING'])(
    'lets a technical Super Admin with step-up license %s',
    async (capability) => {
      await grant(capability);
      const result = await db.query('select licensed from public.feature_flags where name=$1', [
        capability,
      ]);
      expect(result.rows).toEqual([{ licensed: true }]);
    },
  );
  it('lets an authenticated MFA Super Admin change reversible licences without another password', async () => {
    await identity(db, ids.superAdmin);
    await db.query("select public.configure_feature('RESERVATION_MESSAGING',true,null)");
    expect(
      (
        await db.query(
          "select licensed from public.feature_flags where name='RESERVATION_MESSAGING'",
        )
      ).rows,
    ).toEqual([{ licensed: true }]);
    await identity(db, ids.superAdmin, 'aal1');
    await expect(
      db.query("select public.configure_feature('RESERVATION_MESSAGING',false,null)"),
    ).rejects.toThrow();
  });
  it.each([ids.admin, ids.cashier, ids.waiter, ids.host])(
    'prevents staff %s from licensing providers',
    async (actor) => {
      await identity(db, actor);
      await expect(
        db.query("select public.configure_feature('STRIPE',true,$1)", [crypto.randomUUID()]),
      ).rejects.toThrow('FORBIDDEN');
    },
  );
  it('does not license deposits without a licensed provider', async () => {
    await expect(grant('BOOKING_DEPOSITS')).rejects.toThrow(
      'BOOKING_DEPOSITS_PROVIDER_LICENCE_REQUIRED',
    );
  });
  it.each(['STRIPE', 'SATISPAY_API'])(
    'licenses deposit guarantees only after %s, and prevents revoking their last provider',
    async (provider) => {
      await grant(provider);
      await grant('BOOKING_DEPOSITS');
      await expect(grant(provider, false)).rejects.toThrow('BOOKING_DEPOSITS_STILL_LICENSED');
    },
  );
  it('requires removal of configured payment methods before revoking their licence', async () => {
    await grant('STRIPE');
    await db.exec('reset role');
    await db.query(
      "update public.venue_settings set payment_methods=array['CASH','STRIPE']::public.payment_method[] where venue_id=$1",
      [ids.venue],
    );
    await expect(grant('STRIPE', false)).rejects.toThrow('PROVIDER_STILL_CONFIGURED');
  });
  it('allows a safe licence revocation after deposit and venue dependencies are absent', async () => {
    await grant('STRIPE');
    await grant('STRIPE', false);
    const result = await db.query("select licensed from public.feature_flags where name='STRIPE'");
    expect(result.rows).toEqual([{ licensed: false }]);
  });
});
