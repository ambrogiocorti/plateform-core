import { expect, test } from '@playwright/test';
import { ids, password, sql, staff } from './stack/seed.mjs';
import { reset } from './stack/stack.mjs';

// STEP 11 online booking on the disposable local stack: the public page reads the real booking
// configuration and availability through PostgREST as anon and submits through the repository's
// `reservation` Edge Function (Deno, served behind the stack gateway), which calls
// create_public_reservation with the service role. CORE edition: no deposits. The service and
// its booking rules are configured as data (the Admin planning UI is covered by step 5).

const publicBase = 'http://localhost:5173';

test.beforeEach(async () => {
  await reset();
  sql(`update public.venue_settings set reservations_enabled=true where venue_id='${ids.venue}'`);
  sql(`update public.restaurant_profile
    set public_content=coalesce(public_content,'{}'::jsonb)||'{"privacy_url":"https://trattoria-e2e.example/privacy"}'::jsonb`);
  sql(`with s as (insert into public.services(venue_id,name,starts_at,ends_at)
      values('${ids.venue}','Cena','19:00','22:00') returning id,venue_id)
    insert into public.service_booking_rules(venue_id,service_id,max_covers_service,max_arrivals_per_slot,max_covers_per_slot)
    select venue_id,id,40,4,12 from s`);
});

test('prenotazione online: disponibilità reale, invio con la Edge Function, visibile all’accoglienza', async ({
  browser,
}) => {
  const tomorrow = sql(
    `select ((now() at time zone timezone)::date+1)::text from public.venues where id='${ids.venue}'`,
  );
  const visitor = await (await browser.newContext()).newPage();
  const errors: string[] = [];
  visitor.on('pageerror', (error) => errors.push(error.message));
  await visitor.goto(`${publicBase}/prenota`);
  await expect(visitor.getByRole('heading', { name: 'Prenota la tua visita' })).toBeVisible();
  await visitor.getByLabel('Nome', { exact: true }).fill('Giulia');
  await visitor.getByLabel('Cognome').fill('Verdi');
  await visitor.getByLabel('Telefono con prefisso internazionale').fill('+393331234567');
  await visitor.getByLabel('Persone').fill('3');
  await visitor.getByLabel('Data').fill(tomorrow);
  await visitor.getByLabel('Servizio').selectOption({ label: 'Cena' });
  await visitor.getByRole('button', { name: 'Verifica disponibilità' }).click();
  await expect(visitor.getByText(/orari disponibili\. Selezionane uno/)).toBeVisible();
  await visitor.getByLabel('Orario').selectOption('20:00');
  await visitor.getByLabel(/autorizzo il trattamento dei dati/).check();
  await visitor.getByRole('button', { name: 'Richiedi il tavolo' }).click();
  await expect(visitor.getByRole('heading', { name: 'Il tuo tavolo è prenotato.' })).toBeVisible();
  expect(errors).toEqual([]);
  expect(
    sql(`select first_name||' '||last_name||'|'||party_size||'|'||to_char(slot_time,'HH24:MI')||'|'||status||'|'||service_date
      from public.reservations`),
  ).toBe(`Giulia Verdi|3|20:00|RESERVED|${tomorrow}`);
  // The Edge Function applied its per-address rate limit through the database.
  expect(
    sql(`select count(*)>0 from private.rate_limits where bucket like 'reservation-ip:%'`),
  ).toBe('t');

  // L'accoglienza della sede vede la prenotazione per domani.
  const admin = await (await browser.newContext()).newPage();
  await admin.goto('/login');
  await admin.getByLabel('Identificativo staff').fill(staff.admin.email);
  await admin.getByLabel('Password').fill(password);
  await admin.getByRole('button', { name: 'Accedi al servizio' }).click();
  await expect(admin.getByText(`${staff.admin.name} · ADMIN`)).toBeVisible();
  await admin.goto('/accoglienza');
  await admin.getByLabel('Giorno', { exact: true }).fill(tomorrow);
  await admin.getByRole('button', { name: 'FILTRA' }).click();
  await expect(admin.locator('main')).toContainText('Verdi');
  await expect(admin.locator('main')).toContainText('1 risultati · 3 coperti');
});

test('prenotazione online: un gruppo oltre la soglia diventa una richiesta da confermare', async ({
  browser,
}) => {
  const tomorrow = sql(
    `select ((now() at time zone timezone)::date+1)::text from public.venues where id='${ids.venue}'`,
  );
  const visitor = await (await browser.newContext()).newPage();
  await visitor.goto(`${publicBase}/prenota`);
  await visitor.getByLabel('Nome', { exact: true }).fill('Luca');
  await visitor.getByLabel('Cognome').fill('Neri');
  await visitor.getByLabel('Telefono con prefisso internazionale').fill('+393339876543');
  await visitor.getByLabel('Persone').fill('10');
  await visitor.getByLabel('Data').fill(tomorrow);
  await visitor.getByRole('button', { name: 'Verifica disponibilità' }).click();
  await expect(visitor.getByText(/orari disponibili\. Selezionane uno/)).toBeVisible();
  await visitor.getByLabel('Orario').selectOption({ index: 1 });
  await visitor.getByLabel(/autorizzo il trattamento dei dati/).check();
  await visitor.getByRole('button', { name: 'Richiedi il tavolo' }).click();
  await expect(
    visitor.getByRole('heading', { name: 'Abbiamo ricevuto la richiesta.' }),
  ).toBeVisible();
  expect(sql(`select status from public.reservations`)).toBe('REQUESTED');
});
