import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { database, identity, ids, seed } from './harness';

// PGlite counterpart of supabase/tests/security/19_policy_predicates_and_references.sql
// (the full probe suite runs on PostgreSQL 16 with `npm run check:security-pg`).
describe('RLS policy predicates and venue-scoped references', () => {
  let db: PGlite;
  beforeAll(async () => {
    db = await database();
    await seed(db);
  });
  afterAll(async () => {
    await db?.close();
  });

  it('keeps every private function called by an API-role policy executable by that role', async () => {
    const { rows } = await db.query<{ violation: string }>(`
      select distinct format('%s.%s/%s -> %s',pol.tablename,pol.policyname,role_name,p.oid::regprocedure) violation
      from pg_policies pol
      cross join lateral unnest(pol.roles) role_name
      cross join lateral regexp_matches(coalesce(pol.qual,'')||' '||coalesce(pol.with_check,''),'private\\."?([a-z_]+)"?\\(','g') m
      join pg_proc p on p.proname=m[1] and p.pronamespace='private'::regnamespace
      where pol.schemaname in ('public','storage') and role_name in ('anon','authenticated')
        and not has_function_privilege(role_name,p.oid,'execute')
      order by 1`);
    expect(rows).toEqual([]);
  });

  it('filters menu tables for staff instead of failing with a privilege error', async () => {
    for (const user of [ids.admin, ids.waiter]) {
      await identity(db, user);
      for (const table of [
        'menus',
        'menu_venues',
        'menu_categories',
        'menu_dishes',
        'menu_promotions',
      ])
        await expect(db.query(`select count(*) from public.${table}`)).resolves.toBeDefined();
      await db.exec('reset role');
    }
  });

  it('does not expose the responsible waiter helper to API roles', async () => {
    const { rows } = await db.query<{ anon: boolean; authenticated: boolean }>(`
      select has_function_privilege('anon','private.responsible_waiter(uuid)','execute') anon,
        has_function_privilege('authenticated','private.responsible_waiter(uuid)','execute') authenticated`);
    expect(rows).toEqual([{ anon: false, authenticated: false }]);
  });

  it('guards every single-column reference between venue-scoped tables', async () => {
    const { rows } = await db.query<{ reference: string }>(`
      select format('%s.%s',c.conrelid::regclass,a.attname) reference
      from pg_constraint c
      join pg_attribute a on a.attrelid=c.conrelid and a.attnum=c.conkey[1]
      where c.contype='f' and c.connamespace='public'::regnamespace and c.confrelid<>'public.venues'::regclass
        and exists(select 1 from pg_attribute where attrelid=c.conrelid and attname='venue_id' and not attisdropped)
        and exists(select 1 from pg_attribute where attrelid=c.confrelid and attname='venue_id' and not attisdropped)
        and not exists(select 1 from pg_attribute v where v.attrelid=c.conrelid and v.attnum=any(c.conkey) and v.attname='venue_id')
        and not exists(select 1 from pg_trigger t where t.tgrelid=c.conrelid and not t.tgisinternal
          and t.tgfoid='private.enforce_reference_venue()'::regprocedure
          and t.tgname=left('venue_reference_'||a.attname,63))
      order by 1`);
    expect(rows).toEqual([]);
  });

  it('rejects a row whose parent belongs to another venue', async () => {
    await db.exec('begin');
    try {
      await db.exec(`
        update public.feature_flags set licensed=true where name='MULTI_VENUE';
        insert into public.venues(id,name,slug,code,address,phone)
          values('${ids.otherVenue}','Sede due','sede-due','V2','Via test 2','+390000000002');
        insert into public.services(id,venue_id,name,starts_at,ends_at)
          values('40000000-0000-4000-8000-000000000001','${ids.otherVenue}','Cena','19:00','23:00');`);
      await expect(
        db.query(
          `insert into public.waitlist_entries(venue_id,service_id) values($1,'40000000-0000-4000-8000-000000000001')`,
          [ids.venue],
        ),
      ).rejects.toThrow('CROSS_VENUE_REFERENCE');
    } finally {
      await db.exec('rollback');
    }
  });
});
