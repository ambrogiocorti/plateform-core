import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { ids, password, sql, stack, staff } from './stack/seed.mjs';
import { reset } from './stack/stack.mjs';

// Large-group booking deposit (owner decision 2026-10-21) on the disposable local stack: the Admin
// sets the rule in Pianificazione, a large group books through the `reservation` Edge Function and
// lands in PENDING_DEPOSIT, the verified provider result is simulated with the service_role RPCs the
// webhook uses (no provider is ever called: this stack has no provider keys), and the guest's return
// page reads the outcome through the `reservation-deposit` Edge Function.

const publicBase = 'http://localhost:5173';
const functions = `${stack.gateway}/functions/v1`;

function bookingFixture() {
  sql(`update public.venue_settings set reservations_enabled=true where venue_id='${ids.venue}'`);
  sql(`update public.restaurant_profile
    set public_content=coalesce(public_content,'{}'::jsonb)||'{"privacy_url":"https://trattoria-e2e.example/privacy"}'::jsonb`);
  sql(`with s as (insert into public.services(venue_id,name,starts_at,ends_at)
      values('${ids.venue}','Cena','19:00','22:00') returning id,venue_id)
    insert into public.service_booking_rules(venue_id,service_id,max_covers_service,max_arrivals_per_slot,max_covers_per_slot,max_party_size_auto_confirm)
    select venue_id,id,60,4,30,12 from s`);
}

function licenceDeposits() {
  sql(`update public.feature_flags set licensed=true where name='STRIPE'`);
  sql(`update public.feature_flags set licensed=true where name='BOOKING_DEPOSITS'`);
  sql(`update public.venue_settings
    set payment_methods=array['CASH','CARD_POS','STRIPE']::public.payment_method[]
    where venue_id='${ids.venue}'`);
}

const tomorrow = () =>
  sql(
    `select ((now() at time zone timezone)::date+1)::text from public.venues where id='${ids.venue}'`,
  );

test.beforeEach(async () => {
  await reset();
  bookingFixture();
});

test('gruppo numeroso: l’Admin imposta la caparra, il gruppo la vede, paga e la prenotazione è confermata dal server', async ({
  browser,
}) => {
  licenceDeposits();
  const admin = await (await browser.newContext()).newPage();
  await admin.goto('/login');
  await admin.getByLabel('Identificativo staff').fill(staff.admin.email);
  await admin.getByLabel('Password').fill(password);
  await admin.getByRole('button', { name: 'Accedi al servizio' }).click();
  await expect(admin.getByText(`${staff.admin.name} · ADMIN`)).toBeVisible();
  await admin.goto('/pianificazione');
  const settings = admin.getByRole('region', { name: 'Caparra per gruppi numerosi' });
  await expect(settings).toContainText('Pagamento con Stripe.');
  await settings.getByLabel('Chiedi la caparra ai gruppi numerosi').check();
  await settings.getByLabel('Da quante persone si chiede la caparra').fill('6');
  await settings.getByLabel('Importo della caparra in euro').fill('25');
  await settings.getByRole('button', { name: 'Salva caparra · Cena' }).click();
  await expect(settings.getByText(/Attiva: 25,00\s€ da 6 persone\./)).toBeVisible();
  expect(
    sql(`select deposit_policy||'|'||deposit_min_party_size||'|'||deposit_amount_cents||'|'||deposit_no_show_action
      from public.service_booking_rules`),
  ).toBe('CONDITIONAL|6|2500|RETAIN');

  const day = tomorrow();
  const visitor = await (await browser.newContext()).newPage();
  const errors: string[] = [];
  visitor.on('pageerror', (error) => errors.push(error.message));
  await visitor.goto(`${publicBase}/prenota`);
  await visitor.getByLabel('Nome', { exact: true }).fill('Sara');
  await visitor.getByLabel('Cognome').fill('Bianchi');
  await visitor.getByLabel('Telefono con prefisso internazionale').fill('+393331112233');
  await visitor.getByLabel('Persone').fill('8');
  await visitor.getByLabel('Data').fill(day);
  await visitor.getByRole('button', { name: 'Verifica disponibilità' }).click();
  await expect(visitor.getByText(/il ristorante chiede una caparra di garanzia\./)).toBeVisible();
  await visitor.getByLabel('Orario').selectOption('20:00');
  await expect(visitor.locator('#booking-deposit-terms')).toContainText(
    /caparra di garanzia di 25,00\s€/,
  );
  await expect(visitor.locator('#booking-deposit-terms')).toContainText(
    'Non è un anticipo sul conto',
  );
  await visitor.getByLabel(/autorizzo il trattamento dei dati/).check();
  await visitor.getByRole('button', { name: 'Richiedi il tavolo' }).click();
  await expect(
    visitor.getByRole('heading', { name: 'Manca solo la caparra di garanzia' }),
  ).toBeVisible();
  await expect(
    visitor.getByRole('button', { name: 'Paga la caparra con carta (Stripe)' }),
  ).toBeVisible();
  await expect(visitor.getByRole('button', { name: /Satispay/ })).toHaveCount(0);
  expect(
    sql(`select r.status||'|'||d.status||'|'||d.amount_cents||'|'||r.party_size
      from public.reservations r join public.reservation_deposits d on d.reservation_id=r.id`),
  ).toBe('PENDING_DEPOSIT|PENDING|2500|8');

  // The guest's token stays in this tab's session storage across the provider redirect.
  const deposit = sql(`select id from public.reservation_deposits`);
  const token = await visitor.evaluate(
    (id) => sessionStorage.getItem(`plateform:caparra:${id}`),
    deposit,
  );
  expect(token).toMatch(/^[0-9a-f]{64}$/);

  // Before payment the return page says the table is not confirmed yet.
  await visitor.goto(`${publicBase}/prenota?deposito=${deposit}`);
  await expect(visitor.getByRole('heading', { name: 'Pagamento in verifica' })).toBeVisible();

  // Verified provider result, as stripe-webhook applies it after re-reading the session.
  const reference = `cs_test_e2e_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  sql(`set role service_role;
    select public.begin_reservation_deposit('${deposit}','${token}','STRIPE','${randomUUID()}');
    select public.bind_reservation_deposit_provider_reference('${deposit}','STRIPE','${reference}');
    select public.apply_reservation_deposit_callback('STRIPE','read:${reference}:COMPLETED','${reference}','COMPLETED');`);

  await visitor.getByRole('button', { name: 'Aggiorna lo stato del pagamento' }).click();
  await expect(visitor.getByRole('heading', { name: 'Il tuo tavolo è prenotato.' })).toBeVisible();
  await expect(visitor.getByText(/Caparra di garanzia di 25,00\s€ ricevuta/)).toBeVisible();
  expect(
    sql(`select r.status||'|'||d.status from public.reservations r
      join public.reservation_deposits d on d.reservation_id=r.id`),
  ).toBe('RESERVED|COMPLETED');
  expect(errors).toEqual([]);

  // Guests seated: the guarantee goes back through the verified refund queue.
  sql(`update public.reservations set status='ARRIVED'`);
  sql(`update public.reservations set status='SEATED'`);
  expect(
    sql(`select reason||'|'||policy||'|'||state||'|'||requested_refund_cents
      from private.reservation_deposit_no_show_actions`),
  ).toBe('HONOURED|REFUND_FULL|QUEUED|2500');
});

test('gruppo numeroso: senza licenza o provider la caparra è rifiutata; i gruppi piccoli prenotano come prima', async ({
  browser,
}) => {
  // A deposit rule left on the service, but the installation has no deposit licence.
  sql(`update public.service_booking_rules set deposit_policy='CONDITIONAL',deposit_condition_mode='ALL',
    deposit_min_party_size=6,deposit_amount_cents=2000,deposit_expiry_minutes=45,deposit_no_show_action='RETAIN'`);
  const day = tomorrow();
  const visitor = await (await browser.newContext()).newPage();
  await visitor.goto(`${publicBase}/prenota`);
  await visitor.getByLabel('Persone').fill('8');
  await visitor.getByLabel('Data').fill(day);
  await visitor.getByRole('button', { name: 'Verifica disponibilità' }).click();
  await expect(
    visitor.getByText('Non ci sono orari disponibili per questa richiesta.'),
  ).toBeVisible();
  expect(
    sql(`select count(*) from jsonb_array_elements(public.get_public_booking_availability(
      '${ids.venue}',(select id from public.services),'${day}',8)->'slots') s
      where s->>'reason'='BOOKING_DEPOSITS_DISABLED'`),
  ).not.toBe('0');

  // The licence alone is refused without a provider licence.
  expect(() =>
    sql(`update public.feature_flags set licensed=true where name='BOOKING_DEPOSITS'`),
  ).toThrow(/BOOKING_DEPOSITS_PROVIDER_LICENCE_REQUIRED/);

  // Small groups are unchanged.
  await visitor.getByLabel('Nome', { exact: true }).fill('Piero');
  await visitor.getByLabel('Cognome').fill('Rossi');
  await visitor.getByLabel('Telefono con prefisso internazionale').fill('+393334445566');
  await visitor.getByLabel('Persone').fill('2');
  await visitor.getByRole('button', { name: 'Verifica disponibilità' }).click();
  await expect(visitor.getByText(/orari disponibili\. Selezionane uno/)).toBeVisible();
  await expect(visitor.getByText(/caparra/)).toHaveCount(0);
  await visitor.getByLabel('Orario').selectOption('19:30');
  await visitor.getByLabel(/autorizzo il trattamento dei dati/).check();
  await visitor.getByRole('button', { name: 'Richiedi il tavolo' }).click();
  await expect(visitor.getByRole('heading', { name: 'Il tuo tavolo è prenotato.' })).toBeVisible();
  expect(
    sql(
      `select status||'|'||(select count(*) from public.reservation_deposits) from public.reservations`,
    ),
  ).toBe('RESERVED|0');

  // The deposit function refuses an unknown token before anything else.
  const response = await fetch(`${functions}/reservation-deposit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '203.0.113.7' },
    body: JSON.stringify({
      action: 'status',
      deposit_id: randomUUID(),
      access_token: 'f'.repeat(64),
    }),
  });
  expect(response.status).toBe(403);
  expect(((await response.json()) as { code: string }).code).toBe('FORBIDDEN');
});
