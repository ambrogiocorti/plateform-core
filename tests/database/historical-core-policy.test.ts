import { readdir } from 'node:fs/promises';
import type { PGlite } from '@electric-sql/pglite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { database, identity, ids, seed } from './harness';

// Preserve the original CORE denial assertions against their actual historical
// schema. Later immutable migrations deliberately replace this contract with
// per-installation licensing; those paths have separate mandatory tests.
describe('historical CORE policy before the licensed-provider upgrade', () => {
  let db: PGlite;
  beforeAll(async () => {
    const migrations = (await readdir('supabase/migrations'))
      .filter((name) => name.endsWith('.sql'))
      .sort();
    const boundary = migrations.findIndex((name) => name.startsWith('20261018103000_'));
    expect(boundary).toBeGreaterThan(0);
    db = await database(boundary);
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

  it.each(['STRIPE', 'SATISPAY_API', 'BOOKING_DEPOSITS'])(
    'forbids granting %s even to the database owner',
    async (capability) => {
      await expect(
        db.query('update public.feature_flags set licensed=true where name=$1', [capability]),
      ).rejects.toThrow('CORE_PROVIDER_LICENSE_FORBIDDEN');
    },
  );
  it('blocks service-role provider operations before any payment lookup', async () => {
    await db.exec('set role service_role');
    await expect(
      db.query(
        "insert into public.provider_operations(venue_id,payment_id,kind,method,amount_cents) values($1,$2,'PAYMENT','STRIPE',100)",
        [ids.venue, crypto.randomUUID()],
      ),
    ).rejects.toThrow('CORE_PROVIDER_OPERATION_FORBIDDEN');
  });
  it.each([ids.admin, ids.superAdmin])(
    'denies the historical unlicensed statistics endpoint to %s',
    async (actor) => {
      await identity(db, actor);
      await expect(
        db.query('select public.get_operational_statistics($1,current_date,current_date)', [
          ids.venue,
        ]),
      ).rejects.toThrow('FEATURE_NOT_LICENSED');
    },
  );
});
