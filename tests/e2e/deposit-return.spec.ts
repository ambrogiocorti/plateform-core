import { expect, test } from '@playwright/test';

const deposit = '10000000-0000-4000-8000-000000000001';
const venue = {
  id: '10000000-0000-4000-8000-000000000002',
  name: 'Ristorante di prova',
  slug: 'ristorante',
  address: 'Via prova 1',
  phone: '+390000000001',
  email: null,
  opening_hours: {},
  timezone: 'Europe/Rome',
  currency: 'EUR',
  locale: 'it-IT',
  reservations_enabled: true,
};
const token = 'a'.repeat(64);
test.beforeEach(async ({ page }) => {
  await page.route('**/rest/v1/rpc/get_public_site', (route) =>
    route.fulfill({
      json: {
        name: venue.name,
        branding: {},
        content: { privacy_url: 'https://restaurant.test/privacy' },
        contact: {},
        multi_venue: false,
        venues: [venue],
      },
    }),
  );
});

test('payment return remains pending until the server verifies the booking', async ({ page }) => {
  await page.addInitScript(
    ({ deposit, venue, token }) => {
      sessionStorage.setItem(
        `plateform-deposit:${deposit}`,
        JSON.stringify({ deposit, venue, token, saved_at: Date.now() }),
      );
    },
    { deposit, venue: venue.id, token },
  );
  let reads = 0;
  await page.route('**/functions/v1/reservation-deposit', (route) => {
    expect(route.request().postDataJSON()).toEqual({
      action: 'status',
      deposit_id: deposit,
      access_token: token,
    });
    reads++;
    return route.fulfill({
      json: {
        deposit_id: deposit,
        outcome: reads > 1 ? 'CONFIRMED' : 'PENDING',
        amount_cents: 2000,
        currency: 'EUR',
        provider: 'STRIPE',
        providers: ['STRIPE'],
        service_date: '2026-11-10',
        slot_time: '20:00',
        party_size: 8,
      },
    });
  });
  await page.goto(`http://localhost:5173/prenota?sede=ristorante&deposito=${deposit}&success=true`);
  await expect(
    page.getByRole('heading', { name: 'Pagamento in attesa di conferma' }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Prenotazione confermata', exact: true }),
  ).toHaveCount(0);
  expect(page.url()).not.toContain(token);
  await page.getByRole('button', { name: 'Aggiorna esito' }).click();
  await expect(
    page.getByRole('heading', { name: 'Prenotazione confermata', exact: true }),
  ).toBeVisible();
  expect(reads).toBe(2);
});

test('return without the guest capability never queries a deposit or creates another booking', async ({
  page,
}) => {
  let calls = 0;
  await page.route('**/functions/v1/**', (route) => {
    calls++;
    return route.fulfill({ status: 403, json: { code: 'FORBIDDEN' } });
  });
  await page.goto(`http://localhost:5173/prenota?deposito=${deposit}`);
  await expect(
    page.getByRole('heading', { name: 'Verifica la prenotazione con il ristorante' }),
  ).toBeVisible();
  expect(calls).toBe(0);
});

test('a paid but cancelled booking is displayed as cancelled', async ({ page }) => {
  await page.addInitScript(
    ({ deposit, venue, token }) => {
      sessionStorage.setItem(
        `plateform-deposit:${deposit}`,
        JSON.stringify({ deposit, venue, token, saved_at: Date.now() }),
      );
    },
    { deposit, venue: venue.id, token },
  );
  await page.route('**/functions/v1/reservation-deposit', (route) =>
    route.fulfill({
      json: {
        deposit_id: deposit,
        outcome: 'CANCELLED',
        amount_cents: 2000,
        currency: 'EUR',
        provider: 'STRIPE',
        providers: ['STRIPE'],
        service_date: '2026-11-10',
        slot_time: '20:00',
        party_size: 8,
      },
    }),
  );
  await page.goto(`http://localhost:5173/prenota?deposito=${deposit}`);
  await expect(page.getByRole('heading', { name: 'Prenotazione annullata' })).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Prenotazione confermata', exact: true }),
  ).toHaveCount(0);
});
