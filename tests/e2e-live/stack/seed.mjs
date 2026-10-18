// Seeds the disposable local e2e stack: real GoTrue users (password login) and the minimum
// restaurant configuration for one service. Never point this at a shared or remote database.
import { createHmac } from 'node:crypto';
import { execFileSync } from 'node:child_process';

export const stack = {
  gateway: process.env.E2E_SUPABASE_URL ?? 'http://127.0.0.1:54321',
  dbUrl: process.env.E2E_DB_URL ?? 'postgres://postgres@127.0.0.1:54322/plateform_e2e',
  jwtSecret: process.env.E2E_JWT_SECRET ?? 'local-e2e-jwt-secret-not-for-production-0123456789',
};
const local = /^(postgres|postgresql):\/\/[^@]*@(127\.0\.0\.1|localhost)(:\d+)?\//;
if (!local.test(stack.dbUrl)) throw new Error('E2E seed refuses non-local databases');

export function sign(payload) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const body = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(payload)}`;
  return `${body}.${createHmac('sha256', stack.jwtSecret).update(body).digest('base64url')}`;
}
export const serviceKey = sign({
  role: 'service_role',
  iss: 'supabase',
  iat: 1700000000,
  exp: 4100000000,
});
export const anonKey = sign({ role: 'anon', iss: 'supabase', iat: 1700000000, exp: 4100000000 });

export const password = 'E2e-Servizio-2026!';
export const staff = {
  waiter: {
    email: 'cameriere@staff.e2e.test',
    name: 'Marco Cameriere',
    role: 'WAITER',
    landing: '/servizio',
  },
  kitchen: {
    email: 'cuoco@staff.e2e.test',
    name: 'Lucia Cuoca',
    role: 'KITCHEN_STAFF',
    landing: '/cucina',
  },
  pass: { email: 'pass@staff.e2e.test', name: 'Paolo Pass', role: 'PASS', landing: '/pass' },
  cashier: {
    email: 'cassa@staff.e2e.test',
    name: 'Carla Cassa',
    role: 'CASHIER',
    landing: '/cassa',
  },
};
export const ids = {
  venue: '10000000-0000-4000-8000-0000000000e1',
  room: '40000000-0000-4000-8000-0000000000e1',
  layout: '40000000-0000-4000-8000-0000000000e2',
  zone: '40000000-0000-4000-8000-0000000000e3',
  table1: '40000000-0000-4000-8000-0000000000e4',
  table2: '40000000-0000-4000-8000-0000000000e5',
  station: '40000000-0000-4000-8000-0000000000e6',
  category: '40000000-0000-4000-8000-0000000000e7',
  carbonara: '40000000-0000-4000-8000-0000000000e8',
  tiramisu: '40000000-0000-4000-8000-0000000000e9',
  register: '60000000-0000-4000-8000-0000000000e1',
  guanciale: '40000000-0000-4000-8000-0000000000f1',
  egg: '40000000-0000-4000-8000-0000000000f2',
  mascarpone: '40000000-0000-4000-8000-0000000000f3',
  milk: '40000000-0000-4000-8000-0000000000f4',
  eggs: '40000000-0000-4000-8000-0000000000f5',
};

export function sql(text) {
  return execFileSync(
    'psql',
    [stack.dbUrl, '-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1', '-c', text],
    {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  ).trim();
}

async function ensureUser(member) {
  const headers = {
    authorization: `Bearer ${serviceKey}`,
    apikey: serviceKey,
    'content-type': 'application/json',
  };
  const existing = sql(`select id from auth.users where email='${member.email}'`);
  if (existing) return existing;
  const response = await fetch(`${stack.gateway}/auth/v1/admin/users`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      email: member.email,
      password,
      email_confirm: true,
      role: 'authenticated',
    }),
  });
  if (!response.ok)
    throw new Error(`GoTrue user ${member.email}: ${response.status} ${await response.text()}`);
  return (await response.json()).id;
}

export async function seed() {
  const users = {};
  for (const [key, member] of Object.entries(staff)) users[key] = await ensureUser(member);
  if (sql(`select count(*) from public.venues where id='${ids.venue}'`) !== '0') return users;
  sql(`begin;
    insert into public.restaurant_profile(name,public_base_url,staff_base_url,staff_identity_domain)
      values('Trattoria E2E','http://localhost:5173','http://localhost:5174','staff.e2e.test');
    insert into public.restaurant_settings(id) values(true) on conflict do nothing;
    insert into public.system_limits(id) values(true) on conflict do nothing;
    insert into public.venues(id,name,slug,code,address,phone)
      values('${ids.venue}','Sede centrale','sede-centrale','C1','Via Roma 1, Milano','+390200000001');
    insert into public.venue_settings(venue_id) values('${ids.venue}') on conflict do nothing;
    insert into public.staff_profiles(id,display_name,role,scope) values
      ${Object.entries(staff)
        .map(([key, m]) => `('${users[key]}','${m.name}','${m.role}','VENUE')`)
        .join(',')};
    insert into public.staff_venue_assignments(user_id,venue_id)
      select id,'${ids.venue}' from public.staff_profiles where id in (${Object.values(users)
        .map((id) => `'${id}'`)
        .join(',')});
    insert into public.rooms(id,venue_id,name) values('${ids.room}','${ids.venue}','Sala principale');
    insert into public.room_layouts(id,venue_id,room_id,name,active) values('${ids.layout}','${ids.venue}','${ids.room}','Cena',true);
    insert into public.zones(id,venue_id,room_id,name) values('${ids.zone}','${ids.venue}','${ids.room}','Interno');
    insert into public.tables(id,venue_id,room_id,layout_id,zone_id,number,name,seats) values
      ('${ids.table1}','${ids.venue}','${ids.room}','${ids.layout}','${ids.zone}',1,'Tavolo 1',4),
      ('${ids.table2}','${ids.venue}','${ids.room}','${ids.layout}','${ids.zone}',2,'Tavolo 2',2);
    insert into public.stations(id,venue_id,name) values('${ids.station}','${ids.venue}','Cucina calda');
    insert into public.table_assignments(venue_id,waiter_id,mode,zone_id) values('${ids.venue}','${users.waiter}','ZONE','${ids.zone}');
    insert into public.categories(id,name) values('${ids.category}','Primi e dolci');
    insert into public.dishes(id,category_id,name,price_cents) values
      ('${ids.carbonara}','${ids.category}','Carbonara',1400),
      ('${ids.tiramisu}','${ids.category}','Tiramisù',650);
    insert into public.ingredients(id,name) values
      ('${ids.guanciale}','Guanciale'),('${ids.egg}','Uovo'),('${ids.mascarpone}','Mascarpone');
    insert into public.allergens(id,code,name) values('${ids.milk}','MILK','Latte'),('${ids.eggs}','EGGS','Uova')
      on conflict do nothing;
    insert into public.ingredient_allergens
      select '${ids.egg}'::uuid,id from public.allergens where code='EGGS'
      union all select '${ids.mascarpone}'::uuid,id from public.allergens where code='MILK';
    insert into public.dish_ingredients values
      ('${ids.carbonara}','${ids.guanciale}',true),('${ids.carbonara}','${ids.egg}',false),
      ('${ids.tiramisu}','${ids.mascarpone}',false),('${ids.tiramisu}','${ids.egg}',false);
    insert into public.venue_dish_settings(venue_id,dish_id,availability,availability_date,local_station_id) values
      ('${ids.venue}','${ids.carbonara}',50,(now() at time zone 'Europe/Rome')::date,'${ids.station}'),
      ('${ids.venue}','${ids.tiramisu}',50,(now() at time zone 'Europe/Rome')::date,'${ids.station}');
    insert into public.dish_station_assignments values
      ('${ids.venue}','${ids.carbonara}','${ids.station}',true),('${ids.venue}','${ids.tiramisu}','${ids.station}',true);
    insert into public.station_staff_assignments values('${ids.venue}','${ids.station}','${users.kitchen}',true);
    insert into public.cash_registers(id,venue_id,name,code,status) values('${ids.register}','${ids.venue}','Cassa sala','R1','CLOSED');
    insert into public.cashier_assignments(venue_id,cash_register_id,user_id) values('${ids.venue}','${ids.register}','${users.cashier}');
    commit;`);
  return users;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(JSON.stringify(await seed(), null, 2));
}
