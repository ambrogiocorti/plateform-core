import { randomInt, randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { anonKey, ids, sql, supabaseUrl } from './stack.mjs';

// Public online booking on hosted staging: anon availability RPC through PostgREST and the real
// `reservation` Edge Function (rate limit, server-side capacity rules, idempotency).
const service = '40000000-0000-4000-8000-0000000000fa';

test.beforeAll(() => {
  sql(`begin;
    update public.restaurant_profile set public_content=jsonb_set(coalesce(public_content,'{}'::jsonb),
      '{privacy_url}','"https://restaurant.e2e.test/privacy"'::jsonb,true);
    update public.venue_settings set reservations_enabled=true where venue_id='${ids.venue}';
    insert into public.services(id,venue_id,name,starts_at,ends_at)
      values('${service}','${ids.venue}','Cena','19:00','23:00') on conflict (id) do nothing;
    insert into public.service_booking_rules(venue_id,service_id,max_covers_service,slot_interval_minutes,
      max_arrivals_per_slot,max_covers_per_slot,max_party_size_auto_confirm,large_party_mode,deposit_policy)
      values('${ids.venue}','${service}',100,30,10,20,2,'REQUESTED','DISABLED')
      on conflict (service_id) do nothing;
    commit;`);
});

test('prenotazione online: disponibilità, conferma, idempotenza, gruppo su richiesta', async ({
  request,
}) => {
  const key = anonKey();
  const headers = {
    apikey: key,
    authorization: `Bearer ${key}`,
    'content-type': 'application/json',
  };
  const date = sql(
    `select ((now() at time zone (select timezone from public.venues where id='${ids.venue}'))::date + 2)::text`,
  );

  const availability = await request.post(
    `${supabaseUrl}/rest/v1/rpc/get_public_booking_availability`,
    {
      headers,
      data: { p_venue: ids.venue, p_service: service, p_date: date, p_party: 2 },
    },
  );
  expect(availability.status()).toBe(200);
  const slots = (await availability.json()).slots as {
    time: string;
    available: boolean;
    status_if_booked: string;
  }[];
  expect(slots.find((slot) => slot.time === '21:00')).toMatchObject({
    available: true,
    status_if_booked: 'RESERVED',
  });

  const phone = `+39333${randomInt(1_000_000, 9_999_999)}`;
  const booking = {
    venue_id: ids.venue,
    service_id: service,
    date,
    time: '21:00',
    first_name: 'Giulia',
    last_name: 'Prova',
    phone,
    party_size: 2,
    answers: {},
    idempotency_key: randomUUID(),
  };
  const first = await request.post(`${supabaseUrl}/functions/v1/reservation`, {
    headers,
    data: booking,
  });
  expect(first.status()).toBe(200);
  const confirmed = await first.json();
  expect(confirmed.status).toBe('RESERVED');

  const replay = await request.post(`${supabaseUrl}/functions/v1/reservation`, {
    headers,
    data: booking,
  });
  expect(await replay.json()).toEqual(confirmed);

  const group = await request.post(`${supabaseUrl}/functions/v1/reservation`, {
    headers,
    data: { ...booking, time: '21:30', party_size: 3, idempotency_key: randomUUID() },
  });
  expect((await group.json()).status).toBe('REQUESTED');

  const invalid = await request.post(`${supabaseUrl}/functions/v1/reservation`, {
    headers,
    data: { ...booking, phone: '333', idempotency_key: randomUUID() },
  });
  expect(invalid.status()).toBe(400);

  expect(
    sql(`select status||':'||party_size from public.reservations where id='${confirmed.id}'`),
  ).toBe('RESERVED:2');
  expect(
    sql(
      `select count(*) from public.reservations where service_id='${service}' and phone='${phone}'`,
    ),
  ).toBe('2');
});
