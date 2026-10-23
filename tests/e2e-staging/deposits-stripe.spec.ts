import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { sql } from './stack.mjs';
import {
  action,
  bookGroup,
  configureRule,
  groupsService,
  publicBase,
  runReleaseWorker,
} from './deposits';

// Large-group booking deposit (owner decision 2026-10-21) on hosted staging with Stripe TEST mode:
// the SUPER_ADMIN licenses BOOKING_DEPOSITS with step-up, the venue ADMIN sets the rule in
// Pianificazione, a group of 8 books on the public site (local Vite, real staging backend), pays
// the guarantee on a real Stripe Checkout with the test card, and the server confirms it from the
// signed webhook. Then: refund through reservation-deposit-no-show-worker once seated, retention
// on a no-show, expiry of an unpaid deposit.
test.setTimeout(600_000);
test.describe.configure({ mode: 'serial' });
test.beforeAll(groupsService);

/** Pays on Stripe Checkout, then reads the server's outcome on the public return page. */
async function payWithStripe(visitor: Page, deposit: string) {
  await visitor.getByRole('button', { name: 'Paga la caparra con carta (Stripe)' }).click();
  await visitor.waitForURL(/checkout\.stripe\.com/);
  await visitor.locator('#email').fill('gruppo@e2e.test');
  await visitor.locator('#cardNumber').fill('4242 4242 4242 4242');
  await visitor.locator('#cardExpiry').fill('12 / 34');
  await visitor.locator('#cardCvc').fill('123');
  await visitor.locator('#billingName').fill('Gruppo Caparra');
  await visitor.locator('#billingCountry').selectOption('IT');
  const link = visitor.locator('#enableStripePass');
  if ((await link.count()) && (await link.isChecked())) await link.uncheck();
  await visitor.locator('button[type=submit], .SubmitButton').first().click();
  await visitor.waitForURL(/[?&]deposito=/, { timeout: 60_000 });
  // DEPOSIT_RETURN_URL points at a stand-in page until the public site has an HTTPS address; the
  // guest's token is in this tab's session storage for the public origin.
  await visitor.goto(`${publicBase}/prenota?deposito=${deposit}`);
  const booked = visitor.getByRole('heading', { name: 'Il tuo tavolo è prenotato.' });
  const refresh = visitor.getByRole('button', { name: 'Aggiorna lo stato del pagamento' });
  // The page reads the status once on load; the webhook may land a moment later.
  await expect(async () => {
    if (await refresh.isVisible()) await refresh.click({ timeout: 5000 });
    await expect(booked).toBeVisible({ timeout: 5000 });
  }).toPass({ timeout: 90_000 });
  await expect(visitor.getByText(/Caparra di garanzia di 25,00\s€ ricevuta/)).toBeVisible();
  expect(
    sql(`select r.status||'|'||d.status||'|'||d.provider||'|'||(d.provider_reference like 'cs_test_%')
      from public.reservation_deposits d join public.reservations r on r.id=d.reservation_id
      where d.id='${deposit}'`),
  ).toBe('RESERVED|COMPLETED|STRIPE|true');
}

test('caparra Stripe: regola Admin, pagamento, conferma dal webhook, rimborso dopo l’arrivo', async ({
  browser,
}) => {
  await configureRule(browser);
  const { visitor, deposit } = await bookGroup(browser, '20:00');
  await payWithStripe(visitor, deposit);

  const reservation = sql(
    `select reservation_id from public.reservation_deposits where id='${deposit}'`,
  );
  sql(`update public.reservations set status='ARRIVED' where id='${reservation}'`);
  sql(`update public.reservations set status='SEATED' where id='${reservation}'`);
  expect(action(deposit)).toBe('HONOURED|REFUND_FULL|QUEUED|2500');
  await expect
    .poll(
      async () => {
        await runReleaseWorker();
        await new Promise((resolve) => setTimeout(resolve, 5000));
        return sql(`select d.status||'|'||d.refunded_amount_cents||'|'||a.state
          from public.reservation_deposits d join private.reservation_deposit_no_show_actions a
          on a.deposit_id=d.id where d.id='${deposit}'`);
      },
      { timeout: 120_000, intervals: [1000] },
    )
    .toBe('REFUNDED|2500|COMPLETED');
});

test('caparra Stripe: trattenuta se il gruppo non si presenta', async ({ browser }) => {
  const { visitor, deposit } = await bookGroup(browser, '21:00');
  await payWithStripe(visitor, deposit);
  const reservation = sql(
    `select reservation_id from public.reservation_deposits where id='${deposit}'`,
  );
  sql(`update public.reservations set status='NO_SHOW' where id='${reservation}'`);
  await expect
    .poll(
      async () => {
        await runReleaseWorker();
        await new Promise((resolve) => setTimeout(resolve, 5000));
        return action(deposit);
      },
      { timeout: 120_000, intervals: [1000] },
    )
    .toBe('NO_SHOW|RETAIN|RETAINED|0');
  expect(
    sql(
      `select status||'|'||refunded_amount_cents from public.reservation_deposits where id='${deposit}'`,
    ),
  ).toBe('COMPLETED|0');
});

test('caparra non pagata: scade dopo 45 minuti e libera il tavolo', async ({ browser }) => {
  test.setTimeout(55 * 60_000);
  const { deposit } = await bookGroup(browser, '21:30');
  expect(
    sql(`select round(extract(epoch from expires_at-created_at)/60) from public.reservation_deposits
      where id='${deposit}'`),
  ).toBe('45');
  // The deadline is immutable (guard_reservation_deposit): wait for it and for the scheduled
  // run_reservation_deposit_expiry job (every minute).
  await expect
    .poll(
      () =>
        sql(`select r.status||'|'||d.status from public.reservation_deposits d
          join public.reservations r on r.id=d.reservation_id where d.id='${deposit}'`),
      { timeout: 50 * 60_000, intervals: [30_000] },
    )
    .toBe('EXPIRED|EXPIRED');
});
