// Representative restaurant data for the rehearsal, written through the real
// authorization paths: fixtures as owner, then the service flow
// (account → order → service session → cash payment → close) through the
// public RPCs as the authenticated staff roles. Every step emits real audit
// events, so the backup carries an audit trail produced by the application.
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { readFile } from 'node:fs/promises';

export const ids = {
  venue: '10000000-0000-4000-8000-000000000001',
  admin: '20000000-0000-4000-8000-000000000001',
  superAdmin: '20000000-0000-4000-8000-000000000002',
  host: '20000000-0000-4000-8000-000000000003',
  waiter: '20000000-0000-4000-8000-000000000004',
  cashier: '20000000-0000-4000-8000-000000000005',
  room: '40000000-0000-4000-8000-000000000001',
  layout: '40000000-0000-4000-8000-000000000002',
  table: '40000000-0000-4000-8000-000000000003',
  zone: '40000000-0000-4000-8000-000000000004',
  station: '40000000-0000-4000-8000-000000000005',
  category: '40000000-0000-4000-8000-000000000006',
  dish: '40000000-0000-4000-8000-000000000007',
  ingredient: '40000000-0000-4000-8000-000000000008',
  allergen: '40000000-0000-4000-8000-000000000009',
  register: '60000000-0000-4000-8000-000000000001',
};
const session = (user) => user.replace(/^2/, '3');

async function harnessSeed(repoRoot) {
  const source = await readFile(new URL('tests/database/harness.ts', repoRoot), 'utf8');
  const start = source.indexOf('export async function seed');
  const a = source.indexOf('`begin;', start) + 1;
  const b = source.indexOf('commit;`', a) + 7;
  if (start < 0 || a <= 0 || b <= 7) throw new Error('HARNESS_SEED_NOT_FOUND');
  return source.slice(a, b).replace(/\$\{ids\.(\w+)\}/g, (_, key) => {
    if (!ids[key]) throw new Error(`HARNESS_SEED_ID:${key}`);
    return ids[key];
  });
}

export async function seed({ cluster, database, repoRoot, storeRoot }) {
  const sql = (text) => cluster.psql(database, text).then((r) => r.stdout.trim());
  const as = async (user, text) => {
    const claims = JSON.stringify({
      sub: user,
      role: 'authenticated',
      aal: 'aal2',
      iat: Math.floor(Date.now() / 1000),
      session_id: session(user),
      amr: [{ method: 'password', timestamp: Math.floor(Date.now() / 1000) }],
    });
    const out = await sql(`begin;
set local request.jwt.claims to '${claims}';
set local request.headers to '{"x-request-id":"${crypto.randomUUID()}"}';
set local role authenticated;
${text};
commit;`);
    return out ? JSON.parse(out) : null;
  };

  await sql(await harnessSeed(repoRoot));
  await sql(`
insert into public.rooms(id,venue_id,name) values('${ids.room}','${ids.venue}','Sala');
insert into public.room_layouts(id,venue_id,room_id,name,active) values('${ids.layout}','${ids.venue}','${ids.room}','Cena',true);
insert into public.zones(id,venue_id,room_id,name) values('${ids.zone}','${ids.venue}','${ids.room}','Interno');
insert into public.tables(id,venue_id,room_id,layout_id,zone_id,number,name,seats) values('${ids.table}','${ids.venue}','${ids.room}','${ids.layout}','${ids.zone}',1,'Tavolo 1',4);
insert into public.stations(id,venue_id,name) values('${ids.station}','${ids.venue}','Cucina');
insert into public.table_assignments(venue_id,waiter_id,mode,zone_id) values('${ids.venue}','${ids.waiter}','ZONE','${ids.zone}');
insert into public.categories(id,name) values('${ids.category}','Primi');
insert into public.dishes(id,category_id,name,price_cents) values('${ids.dish}','${ids.category}','Cacio e pepe',1800);
insert into public.ingredients(id,name) values('${ids.ingredient}','Pecorino');
insert into public.allergens(id,code,name) values('${ids.allergen}','MILK','Latte');
insert into public.ingredient_allergens values('${ids.ingredient}','${ids.allergen}');
insert into public.dish_ingredients values('${ids.dish}','${ids.ingredient}',false);
insert into public.venue_dish_settings(venue_id,dish_id,availability,availability_date,local_station_id)
  values('${ids.venue}','${ids.dish}',10,(now() at time zone 'Europe/Rome')::date,'${ids.station}');
insert into public.dish_station_assignments values('${ids.venue}','${ids.dish}','${ids.station}',true);
insert into public.cash_registers(id,venue_id,name,code,status) values('${ids.register}','${ids.venue}','Reception','R1','OPEN');
insert into public.cashier_assignments(venue_id,cash_register_id,user_id) values('${ids.venue}','${ids.register}','${ids.cashier}');
update auth.users set email=replace(id::text,'-','')||'@staff.test',encrypted_password=extensions.crypt('local-only',extensions.gen_salt('bf',4));
insert into auth.refresh_tokens(token,user_id,session_id) select md5(id::text),user_id::text,id from auth.sessions;
`);

  // Service flow through the authoritative RPCs.
  const account = await as(
    ids.waiter,
    `select public.create_account('${ids.table}','Rossi',2,null,'${crypto.randomUUID()}')`,
  );
  const version = await sql(`select version from public.accounts where id='${account.id}'`);
  await as(
    ids.waiter,
    `select public.create_order('${account.id}','${JSON.stringify([{ dish_id: ids.dish, quantity: 2, step: 1 }])}','${crypto.randomUUID()}',${Number(version)})`,
  );
  await as(
    ids.cashier,
    `select public.open_service_session('${ids.venue}',null,'${ids.register}',30000,'${crypto.randomUUID()}')`,
  );
  const payment = await as(
    ids.cashier,
    `select public.create_payment('${account.id}','${ids.register}',3600,300,'CASH','${crypto.randomUUID()}')`,
  );
  await as(ids.cashier, `select public.confirm_manual_payment('${payment.id}',true)`);
  await as(ids.cashier, `select public.close_account('${account.id}')`);
  // A second, still open account keeps a live customer access code in private state.
  await as(
    ids.waiter,
    `select public.create_account('${ids.table}','Bianchi',3,null,'${crypto.randomUUID()}')`,
  ).catch(() => null);

  // Storage objects: metadata row + bytes, as the hosted service would hold them.
  const objects = [
    {
      bucket: 'branding',
      name: 'logo/plateform.png',
      bytes: await readFile(new URL('assets/public/brand-reference.png', repoRoot)),
      type: 'image/png',
    },
    {
      bucket: 'documents',
      name: 'haccp/2026-10-18-registro.txt',
      bytes: Buffer.from('Registro HACCP di prova: temperature frigo 2°C, 3°C, 2°C.\n'),
      type: 'text/plain',
    },
  ];
  for (const o of objects) {
    const path = join(storeRoot, o.bucket, ...o.name.split('/'));
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, o.bytes, { mode: 0o600 });
    await sql(`insert into storage.objects(bucket_id,name,metadata,path_tokens) values('${o.bucket}','${o.name}',
      '${JSON.stringify({ size: o.bytes.length, mimetype: o.type, cacheControl: 'max-age=3600', lastModified: '2026-10-18T08:00:00.000Z' })}',string_to_array('${o.name}','/'))`);
  }
  return { accountId: account.id, paymentId: payment.id, objects: objects.length };
}
