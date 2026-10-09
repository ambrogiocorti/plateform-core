import { randomUUID } from 'node:crypto';
import { nativeAssert } from './native-ci-context.mjs';

export const nativeActors = [
  { name: 'adminA', role: 'ADMIN', scope: 'VENUE', venue: 'venueA' },
  { name: 'adminB', role: 'ADMIN', scope: 'VENUE', venue: 'venueB' },
  { name: 'chainAdmin', role: 'ADMIN', scope: 'CHAIN' },
  { name: 'superAdmin', role: 'SUPER_ADMIN', scope: 'CHAIN' },
  { name: 'waiterA', role: 'WAITER', scope: 'VENUE', venue: 'venueA' },
  { name: 'waiterB', role: 'WAITER', scope: 'VENUE', venue: 'venueB' },
  { name: 'outsider' },
];

export function nativeFixtureIDs() {
  return { venueA: randomUUID(), venueB: randomUUID(), roomA: randomUUID(), roomB: randomUUID() };
}

export function nativeUUID(value) {
  nativeAssert(
    typeof value === 'string' && /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value),
    'NATIVE_CI_INVALID_FIXTURE_ID',
  );
  return value;
}

// Explicit fixture DATA only; all application DDL comes from db:install.
// Auth users and sessions are created through GoTrue, never forged in SQL.
export function nativeFixtureSQL(ids, users) {
  for (const id of Object.values(ids)) nativeUUID(id);
  for (const actor of nativeActors) nativeUUID(users[actor.name]);
  return `begin;
    do $empty$ begin
      if exists(select 1 from public.restaurant_profile)
        or exists(select 1 from public.venues)
        or exists(select 1 from public.staff_profiles)
        or exists(select 1 from private.staff_sessions) then
        raise exception 'NATIVE_CI_REQUIRES_EMPTY_FIXTURE_TARGET';
      end if;
    end $empty$;
    insert into public.restaurant_profile(name,public_base_url,staff_base_url,staff_identity_domain)
      values('Native CI restaurant','https://restaurant.native-ci.invalid',
        'https://staff.native-ci.invalid','native-ci.invalid');
    insert into public.restaurant_settings(id) values(true);
    insert into public.system_limits(id) values(true);
    update public.feature_flags set licensed=true where name='MULTI_VENUE';
    insert into public.venues(id,name,slug,code,address,phone) values
      ('${ids.venueA}','Native A','native-a','NATIVE_A','Fixture A','+390000000001'),
      ('${ids.venueB}','Native B','native-b','NATIVE_B','Fixture B','+390000000002');
    insert into public.venue_settings(venue_id) values('${ids.venueA}'),('${ids.venueB}');
    insert into public.rooms(id,venue_id,name) values
      ('${ids.roomA}','${ids.venueA}','Native room A'),
      ('${ids.roomB}','${ids.venueB}','Native room B');
    insert into public.staff_profiles(id,display_name,role,scope) values
      ${nativeActors
        .filter((actor) => actor.role)
        .map(
          (actor) =>
            `('${users[actor.name]}','Native ${actor.name}','${actor.role}','${actor.scope}')`,
        )
        .join(',\n')};
    insert into public.staff_venue_assignments(user_id,venue_id) values
      ${nativeActors
        .filter((actor) => actor.venue)
        .map((actor) => `('${users[actor.name]}','${ids[actor.venue]}')`)
        .join(',\n')};
    commit;`;
}
