import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { database } from './harness';
import {
  nativeActors,
  nativeFixtureIDs,
  nativeFixtureSQL,
} from '../../scripts/native-ci-fixtures.mjs';

describe('native HTTP fixture data uses the canonical schema without forged sessions', () => {
  let db: PGlite;
  const ids = nativeFixtureIDs();
  const users = Object.fromEntries(nativeActors.map((actor) => [actor.name, crypto.randomUUID()]));
  beforeAll(async () => {
    db = await database();
    // Platform adapter data for this embedded regression only. The native CI
    // runner creates these identities through the real GoTrue admin endpoint.
    for (const user of Object.values(users))
      await db.query('insert into auth.users(id) values($1)', [user]);
    await db.exec(nativeFixtureSQL(ids, users));
  });
  afterAll(async () => {
    await db?.close();
  });

  it('keeps MFA enabled and provides two distinct venues and server-owned staff scopes', async () => {
    expect(
      (await db.query('select admin_mfa_required from public.restaurant_settings')).rows,
    ).toEqual([{ admin_mfa_required: true }]);
    expect(
      (await db.query<{ id: string }>('select id from public.venues order by id')).rows.map(
        (row) => row.id,
      ),
    ).toEqual([ids.venueA, ids.venueB].sort());
    expect(
      (
        await db.query<{ count: number }>(
          'select count(*)::int as count from public.staff_profiles',
        )
      ).rows[0]!.count,
    ).toBe(6);
    expect(
      (
        await db.query<{ count: number }>(
          'select count(*)::int as count from public.staff_venue_assignments',
        )
      ).rows[0]!.count,
    ).toBe(4);
  });

  it('creates no Auth or operational session and grants no release certification', async () => {
    expect((await db.query('select 1 from auth.sessions')).rows).toEqual([]);
    expect((await db.query('select 1 from private.staff_sessions')).rows).toEqual([]);
    expect(
      (await db.query("select 1 from private.release_test_results where status='PASS'")).rows,
    ).toEqual([]);
    expect(
      (await db.query("select 1 from private.release_gate_checks where status='PASS'")).rows,
    ).toEqual([]);
  });

  it('refuses to overwrite an existing fixture target', async () => {
    await expect(db.exec(nativeFixtureSQL(ids, users))).rejects.toThrow(
      'NATIVE_CI_REQUIRES_EMPTY_FIXTURE_TARGET',
    );
    await db.exec('rollback');
    expect(
      (
        await db.query<{ count: number }>(
          'select count(*)::int as count from public.staff_profiles',
        )
      ).rows[0]!.count,
    ).toBe(6);
  });
});
