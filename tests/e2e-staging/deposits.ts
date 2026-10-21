import { randomInt } from 'node:crypto';
import { expect } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';
import { ids, sql, staff } from './stack.mjs';
import { licenseProvider, mfaDevice } from './flow';

// Shared steps of the large-group deposit specs (deposits-stripe, deposits-satispay).
export const publicBase = 'http://localhost:5173';
export const groups = '40000000-0000-4000-8000-0000000000fb';
export const day = () =>
  sql(
    `select ((now() at time zone timezone)::date + 3)::text from public.venues where id='${ids.venue}'`,
  );

export function groupsService() {
  sql(`begin;
    update public.restaurant_profile set public_content=jsonb_set(coalesce(public_content,'{}'::jsonb),
      '{privacy_url}','"https://restaurant.e2e.test/privacy"'::jsonb,true);
    update public.venue_settings set reservations_enabled=true,
      payment_methods=array(select distinct unnest(payment_methods||'{STRIPE,SATISPAY_API}'))
      where venue_id='${ids.venue}';
    insert into public.services(id,venue_id,name,starts_at,ends_at)
      values('${groups}','${ids.venue}','Cena gruppi','19:00','23:00') on conflict (id) do nothing;
    insert into public.service_booking_rules(venue_id,service_id,max_covers_service,slot_interval_minutes,
      max_arrivals_per_slot,max_covers_per_slot,max_party_size_auto_confirm,large_party_mode,deposit_policy)
      values('${ids.venue}','${groups}',400,30,20,80,12,'REQUESTED','DISABLED')
      on conflict (service_id) do nothing;
    commit;`);
}

export async function configureRule(browser: Browser) {
  const superAdmin = await mfaDevice(browser, staff.superAdmin);
  await licenseProvider(superAdmin, 'BOOKING_DEPOSITS');
  const admin = await mfaDevice(browser, staff.admin);
  await admin.goto('/pianificazione');
  const settings = admin.getByRole('region', { name: 'Caparra per gruppi numerosi' });
  const form = settings.getByRole('form', { name: 'Caparra · Cena gruppi' });
  await form.getByLabel('Chiedi la caparra ai gruppi numerosi').check();
  await form.getByLabel('Da quante persone si chiede la caparra').fill('6');
  await form.getByLabel('Importo della caparra in euro').fill('25');
  await form.getByLabel(/Rimborso automatico se cancellano/).fill('24');
  await form.getByRole('button', { name: 'Salva caparra · Cena gruppi' }).click();
  await expect(form.getByText(/Attiva: 25,00\s€ da 6 persone\./)).toBeVisible();
  expect(
    sql(`select deposit_policy||'|'||deposit_min_party_size||'|'||deposit_amount_cents||'|'||
      deposit_no_show_action||'|'||deposit_cancel_refund_hours from public.service_booking_rules
      where service_id='${groups}'`),
  ).toBe('CONDITIONAL|6|2500|RETAIN|24');
}

/** A group of 8 books on the public site; returns the visitor tab, the deposit and its token. */
export async function bookGroup(
  browser: Browser,
  time: string,
): Promise<{ visitor: Page; deposit: string; token: string }> {
  const visitor = await (await browser.newContext({ locale: 'it-IT' })).newPage();
  const phone = `+39333${randomInt(1_000_000, 9_999_999)}`;
  await visitor.goto(`${publicBase}/prenota`);
  await visitor.getByLabel('Servizio').selectOption({ label: 'Cena gruppi' });
  await visitor.getByLabel('Nome', { exact: true }).fill('Gruppo');
  await visitor.getByLabel('Cognome').fill('Caparra');
  await visitor.getByLabel('Telefono con prefisso internazionale').fill(phone);
  await visitor.getByLabel('Persone').fill('8');
  await visitor.getByLabel('Data').fill(day());
  await visitor.getByRole('button', { name: 'Verifica disponibilità' }).click();
  await expect(visitor.getByText(/il ristorante chiede una caparra di garanzia\./)).toBeVisible();
  await visitor.getByLabel('Orario').selectOption(time);
  await expect(visitor.locator('#booking-deposit-terms')).toContainText(
    /caparra di garanzia di 25,00\s€/,
  );
  await visitor.getByLabel(/autorizzo il trattamento dei dati/).check();
  await visitor.getByRole('button', { name: 'Richiedi il tavolo' }).click();
  await expect(
    visitor.getByRole('heading', { name: 'Manca solo la caparra di garanzia' }),
  ).toBeVisible();
  await expect(visitor.getByRole('button', { name: 'Paga la caparra con Satispay' })).toBeVisible();
  const deposit = sql(`select d.id from public.reservation_deposits d join public.reservations r
    on r.id=d.reservation_id where r.phone='${phone}'`);
  expect(
    sql(`select r.status||'|'||d.status||'|'||d.amount_cents||'|'||r.party_size
      from public.reservation_deposits d join public.reservations r on r.id=d.reservation_id
      where d.id='${deposit}'`),
  ).toBe('PENDING_DEPOSIT|PENDING|2500|8');
  // The guest's only authority, kept in this tab's session storage across the provider redirect.
  const token = await visitor.evaluate(
    (id) => sessionStorage.getItem(`plateform:caparra:${id}`) ?? '',
    deposit,
  );
  expect(token).toMatch(/^[0-9a-f]{64}$/);
  return { visitor, deposit, token };
}

export async function runReleaseWorker() {
  const request = sql(`select public.invoke_reservation_deposit_no_show_worker(10)`);
  expect(request).not.toBe('');
}

export const action = (deposit: string) =>
  sql(`select reason||'|'||policy||'|'||state||'|'||coalesce(requested_refund_cents,0)
    from private.reservation_deposit_no_show_actions where deposit_id='${deposit}'`);
