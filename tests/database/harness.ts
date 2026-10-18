import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { readFile, readdir } from 'node:fs/promises';

// Real PostgreSQL engine in WASM. Only the Supabase-owned host objects are a test fixture
// (supabase/tests/host-fixture.sql, shared with scripts/replay-migrations-postgres.mjs).
// These tests do not claim to exercise GoTrue, PostgREST, Storage, or Realtime.
export async function database(through = Number.POSITIVE_INFINITY) {
  const db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(await readFile('supabase/tests/host-fixture.sql', 'utf8'));
  const names = (await readdir('supabase/migrations'))
    .filter((name) => name.endsWith('.sql'))
    .sort()
    .slice(0, through);
  for (const name of names) {
    try {
      let sql = await readFile(`supabase/migrations/${name}`, 'utf8');
      // pg_cron itself is host-provided on Supabase; the contract above is used in PGlite.
      sql = sql.replace(/^create extension if not exists pg_cron;\s*$/gim, '');
      // Continuity rehearsal tables are created by the versioned recovery migration.
      // Never inject out-of-band tables into a clean-install replay fixture.
      await db.exec(sql);
      const match = /^(\d+)_([^.]*)\.sql$/.exec(name);
      if (match)
        await db.query(
          `insert into supabase_migrations.schema_migrations(version,name,statements) values($1,$2,$3)`,
          [match[1], match[2], [sql]],
        );
    } catch (error) {
      await db.close();
      throw new Error(`Migration ${name} failed`, { cause: error });
    }
  }
  return db;
}

export async function identity(db: PGlite, user: string, aal = 'aal2') {
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [
    JSON.stringify({
      sub: user,
      aal,
      iat: Math.floor(Date.now() / 1000),
      session_id: sessionId(user),
      amr: [{ method: 'password', timestamp: Math.floor(Date.now() / 1000) }],
    }),
  ]);
  await db.exec('set role authenticated');
}

export function sessionId(user: string) {
  return user.replace(/^2/, '3');
}

export const ids = {
  venue: '10000000-0000-4000-8000-000000000001',
  otherVenue: '10000000-0000-4000-8000-000000000002',
  admin: '20000000-0000-4000-8000-000000000001',
  superAdmin: '20000000-0000-4000-8000-000000000002',
  host: '20000000-0000-4000-8000-000000000003',
  waiter: '20000000-0000-4000-8000-000000000004',
  cashier: '20000000-0000-4000-8000-000000000005',
  session: '30000000-0000-4000-8000-000000000001',
} as const;

export async function seed(db: PGlite) {
  await db.exec(`begin;
    insert into public.restaurant_profile(name,public_base_url,staff_base_url,staff_identity_domain)
      values('Fixture restaurant','https://restaurant.test','https://staff.restaurant.test','staff.test');
    insert into public.restaurant_settings(id) values(true);
    insert into public.system_limits(id) values(true);
    insert into public.venues(id,name,slug,code,address,phone)
      values('${ids.venue}','Sede uno','sede-uno','V1','Via test 1','+390000000001');
    insert into public.venue_settings(venue_id) values('${ids.venue}');
    insert into auth.users(id) values('${ids.admin}'),('${ids.superAdmin}'),('${ids.host}'),('${ids.waiter}'),('${ids.cashier}');
    insert into public.staff_profiles(id,display_name,role,scope) values
      ('${ids.admin}','Admin test','ADMIN','VENUE'),
      ('${ids.superAdmin}','Tecnico test','SUPER_ADMIN','CHAIN'),
      ('${ids.host}','Host test','HOST','VENUE'),
      ('${ids.waiter}','Waiter test','WAITER','VENUE'),
      ('${ids.cashier}','Cashier test','CASHIER','VENUE');
    insert into public.staff_venue_assignments(user_id,venue_id)
      select id,'${ids.venue}' from public.staff_profiles where role<>'SUPER_ADMIN';
    insert into auth.sessions(id,user_id) select replace(id::text,'20000000-','30000000-')::uuid,id from public.staff_profiles;
    insert into private.staff_sessions(session_id,user_id,full_auth_at,unlocked_until)
      select id,user_id,now(),now()+interval '2 hours' from auth.sessions;
    commit;`);
}
