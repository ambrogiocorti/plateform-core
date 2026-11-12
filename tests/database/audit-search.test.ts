import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { database, identity, ids, seed } from './harness';

describe('Scoped technical audit search', () => {
  let db: PGlite;
  const request = 'a4000000-0000-4000-8000-000000000001';
  beforeAll(async () => {
    db = await database();
    await seed(db);
    await db.query(
      `insert into public.audit_log(timestamp,actor_type,actor_user_id,actor_role,venue_id,action,resource_type,resource_id,operation,result,request_id,correlation_id)
      select '2026-09-15T12:00:00Z', 'STAFF', $1, 'CASHIER', $2, 'SEARCH_FIXTURE_'||n, 'payments', gen_random_uuid(), 'INSERT', 'SUCCESS', $3, $3
      from generate_series(1,5) n`,
      [ids.cashier, ids.venue, request],
    );
  });
  beforeEach(async () => {
    await db.exec('begin');
    await identity(db, ids.superAdmin);
  });
  afterEach(async () => {
    await db.exec('rollback; reset role');
  });
  afterAll(async () => {
    await db?.close();
  });
  type Page = {
    events: {
      id: string;
      timestamp: string;
      actor_user_id: string;
      venue_id: string;
      request_id: string;
    }[];
    has_more: boolean;
  };
  async function page(before?: { id: string; timestamp: string }) {
    return (
      await db.query<{ result: Page }>(
        'select public.search_audit(p_request=>$1,p_before_at=>$2,p_before_id=>$3,p_limit=>2) as result',
        [request, before?.timestamp ?? null, before?.id ?? null],
      )
    ).rows[0]!.result;
  }
  it('paginates tied timestamps with no duplication or skipped events', async () => {
    const first = await page();
    const second = await page(first.events.at(-1));
    const third = await page(second.events.at(-1));
    expect([first.events.length, second.events.length, third.events.length]).toEqual([2, 2, 1]);
    expect([first.has_more, second.has_more, third.has_more]).toEqual([true, true, false]);
    expect(
      new Set([...first.events, ...second.events, ...third.events].map((entry) => entry.id)).size,
    ).toBe(5);
  });
  it('combines actor, venue, time, action and result filters on the server', async () => {
    const result = (
      await db.query<{ result: Page }>(
        `select public.search_audit(p_actor=>$1,p_venue=>$2,p_request=>$3,p_correlation=>$3,p_role=>'CASHIER',p_impersonated=>false,p_resource_type=>'payments',p_action=>'fixture_2',p_result=>'SUCCESS',p_from=>'2026-09-15T11:59:00Z',p_to=>'2026-09-15T12:01:00Z') as result`,
        [ids.cashier, ids.venue, request],
      )
    ).rows[0]!.result;
    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({
      actor_user_id: ids.cashier,
      venue_id: ids.venue,
      request_id: request,
    });
    expect(
      (
        await db.query<{ result: Page }>(
          "select public.search_audit(p_request=>$1,p_result=>'DENIED') as result",
          [request],
        )
      ).rows[0]!.result.events,
    ).toEqual([]);
    expect(
      (
        await db.query<{ result: Page }>(
          'select public.search_audit(p_correlation=>$1,p_impersonated=>true) as result',
          [request],
        )
      ).rows[0]!.result.events,
    ).toEqual([]);
  });
  it('denies full technical audit to Admin and Cashier and requires Super Admin MFA', async () => {
    for (const user of [ids.admin, ids.cashier]) {
      await identity(db, user);
      await db.exec('savepoint denied');
      await expect(page()).rejects.toThrow('FORBIDDEN');
      await db.exec('rollback to savepoint denied');
    }
    await identity(db, ids.superAdmin, 'aal1');
    await expect(page()).rejects.toThrow();
  });
  it('rejects an incomplete cursor and an unbounded page size', async () => {
    await db.exec('savepoint invalid');
    await expect(
      db.query('select public.search_audit(p_before_id=>$1)', [request]),
    ).rejects.toThrow('INVALID_FILTER');
    await db.exec('rollback to savepoint invalid');
    await expect(db.exec('select public.search_audit(p_limit=>10000)')).rejects.toThrow(
      'INVALID_FILTER',
    );
  });
});
