import { tokenDigest, type DeviceBinding } from '../../tools/venue-hub/hub.ts';
import { ids, sessionId } from '../database/harness';

// Shared venue fixture for hub tests (Vitest) and the browser proof (Playwright).
// Device tokens are test-only values; real tokens are issued at pairing time.
export { ids };

export const room = '40000000-0000-4000-8000-000000000001';
export const layout = '40000000-0000-4000-8000-000000000002';
export const table = '40000000-0000-4000-8000-000000000003';
export const zone = '40000000-0000-4000-8000-000000000004';
export const station = '40000000-0000-4000-8000-000000000005';
export const category = '40000000-0000-4000-8000-000000000006';
export const dish = '40000000-0000-4000-8000-000000000007';
export const register = '60000000-0000-4000-8000-000000000001';
export const ingredient = '40000000-0000-4000-8000-000000000008';
export const table2 = '40000000-0000-4000-8000-000000000013';
export const cook = '20000000-0000-4000-8000-000000000010';
export const pass = '20000000-0000-4000-8000-000000000012';

export const tokens = {
  waiter: 'waiter-device-token-0123456789abcdef0123456789',
  kitchen: 'kitchen-device-token-0123456789abcdef012345678',
  pass: 'pass-device-token-0123456789abcdef0123456789abc',
  cashier: 'cashier-device-token-0123456789abcdef01234567',
};
export const future = new Date(Date.now() + 8 * 3600_000).toISOString();
export const devices: DeviceBinding[] = [
  { token: tokens.waiter, user: ids.waiter, label: 'Cameriere tablet' },
  { token: tokens.kitchen, user: cook, label: 'Cucina KDS' },
  { token: tokens.pass, user: pass, label: 'Pass' },
  { token: tokens.cashier, user: ids.cashier, label: 'Cassa' },
].map((d) => ({
  token_sha256: tokenDigest(d.token),
  user_id: d.user,
  session_id: sessionId(d.user),
  label: d.label,
  expires_at: future,
}));

export const SEED = `begin;
  insert into public.restaurant_profile(name,public_base_url,staff_base_url,staff_identity_domain)
    values('Trattoria LAN','https://restaurant.test','https://staff.restaurant.test','staff.test');
  insert into public.restaurant_settings(id) values(true);
  insert into public.system_limits(id) values(true);
  insert into public.venues(id,name,slug,code,address,phone)
    values('${ids.venue}','Sede uno','sede-uno','V1','Via test 1','+390000000001');
  insert into public.venue_settings(venue_id) values('${ids.venue}');
  insert into auth.users(id) values('${ids.admin}'),('${ids.waiter}'),('${ids.cashier}'),('${cook}'),('${pass}');
  insert into public.staff_profiles(id,display_name,role,scope) values
    ('${ids.admin}','Admin','ADMIN','VENUE'),('${ids.waiter}','Cameriere','WAITER','VENUE'),
    ('${ids.cashier}','Cassa','CASHIER','VENUE'),('${cook}','Cuoco','KITCHEN_STAFF','VENUE'),
    ('${pass}','Pass','PASS','VENUE');
  insert into public.staff_venue_assignments(user_id,venue_id) select id,'${ids.venue}' from public.staff_profiles;
  insert into auth.sessions(id,user_id) select replace(id::text,'20000000-','30000000-')::uuid,id from public.staff_profiles;
  insert into private.staff_sessions(session_id,user_id,full_auth_at,unlocked_until)
    select id,user_id,now(),now()+interval '8 hours' from auth.sessions;
  insert into public.rooms(id,venue_id,name) values('${room}','${ids.venue}','Sala');
  insert into public.room_layouts(id,venue_id,room_id,name,active) values('${layout}','${ids.venue}','${room}','Cena',true);
  insert into public.zones(id,venue_id,room_id,name) values('${zone}','${ids.venue}','${room}','Interno');
  insert into public.tables(id,venue_id,room_id,layout_id,zone_id,number,name,seats) values('${table}','${ids.venue}','${room}','${layout}','${zone}',1,'Tavolo 1',4),
    ('${table2}','${ids.venue}','${room}','${layout}','${zone}',2,'Tavolo 2',4);
  insert into public.stations(id,venue_id,name) values('${station}','${ids.venue}','Cucina');
  insert into public.table_assignments(venue_id,waiter_id,mode,zone_id) values('${ids.venue}','${ids.waiter}','ZONE','${zone}');
  insert into public.categories(id,name) values('${category}','Primi');
  insert into public.dishes(id,category_id,name,price_cents) values('${dish}','${category}','Carbonara',1250);
  insert into public.ingredients(id,name) values('${ingredient}','Guanciale');
  insert into public.dish_ingredients values('${dish}','${ingredient}',false);
  insert into public.venue_dish_settings(venue_id,dish_id,availability,availability_date,local_station_id)
    values('${ids.venue}','${dish}',10,(now() at time zone 'Europe/Rome')::date,'${station}');
  insert into public.dish_station_assignments values('${ids.venue}','${dish}','${station}',true);
  insert into public.station_staff_assignments values('${ids.venue}','${station}','${cook}',true);
  insert into public.cash_registers(id,venue_id,name,code,status) values('${register}','${ids.venue}','Cassa 1','R1','OPEN');
  insert into public.cashier_assignments(venue_id,cash_register_id,user_id) values('${ids.venue}','${register}','${ids.cashier}');
commit;`;

export function client(base: string, token: string) {
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  return {
    async rpc<T = unknown>(name: string, args: Record<string, unknown>) {
      const res = await fetch(`${base}/v1/rpc/${name}`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ args }),
      });
      const body = (await res.json()) as { result?: T; error?: string };
      if (!res.ok) throw new Error(body.error ?? `HTTP_${res.status}`);
      return body.result as T;
    },
    async read<T = Record<string, unknown>>(table: string, id?: string) {
      const res = await fetch(`${base}/v1/table/${table}${id ? `?eq.id=${id}` : ''}`, { headers });
      const body = (await res.json()) as { rows?: T[]; error?: string };
      if (!res.ok) throw new Error(body.error ?? `HTTP_${res.status}`);
      return body.rows ?? [];
    },
  };
}
