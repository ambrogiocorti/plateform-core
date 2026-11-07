import { expect, test } from '@playwright/test';

const venue = {
  id: '10000000-0000-4000-8000-000000000001',
  name: 'Osteria Test',
  slug: 'osteria',
  address: 'Via di prova',
  phone: '+390000000000',
  email: null,
  opening_hours: {},
  timezone: 'Europe/Rome',
  currency: 'EUR',
  locale: 'it-IT',
  reservations_enabled: true,
};
const site = {
  name: 'Osteria Test',
  branding: {},
  content: { privacy_url: 'https://ristorante.example/privacy' },
  contact: {},
  multi_venue: false,
  venues: [venue],
};
const serviceId = '10000000-0000-4000-8000-000000000002';
const entryId = '10000000-0000-4000-8000-000000000003';

test('guest can request waitlist without an account, but never sees a confirmed booking', async ({
  page,
}) => {
  let registrations = 0;
  await page.route('**/rest/v1/rpc/get_public_site', (route) => route.fulfill({ json: site }));
  await page.route('**/rest/v1/rpc/get_booking_configuration', (route) =>
    route.fulfill({
      json: {
        services: [
          {
            id: serviceId,
            name: 'Cena',
            starts_at: '19:00:00',
            ends_at: '23:00:00',
            weekdays: [1, 2, 3, 4, 5, 6, 7],
            slot_interval_minutes: 30,
          },
        ],
      },
    }),
  );
  await page.route('**/functions/v1/waitlist', async (route) => {
    registrations++;
    const body = route.request().postDataJSON();
    expect(body.action).toBe('CREATE');
    expect(body.customer_phone).toBe('+393331234567');
    expect(body.idempotency_key).toBeTruthy();
    await route.fulfill({
      json: {
        id: entryId,
        status: 'WAITING',
        service_date: body.date,
        preferred_start_time: '19:00:00',
        preferred_end_time: null,
      },
    });
  });
  await page.goto('http://localhost:5173/lista-attesa?sede=osteria');
  await expect(page.getByRole('heading', { name: 'Lista d’attesa · Osteria Test' })).toBeVisible();
  await expect(page.getByText('La richiesta non è una prenotazione.')).toBeVisible();
  await page.getByLabel('Nome e cognome').fill('Maria Rossi');
  await page.getByLabel('Telefono con prefisso internazionale').fill('+393331234567');
  await page
    .getByLabel('Data')
    .fill(new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10));
  await page.getByLabel('Orario preferito').selectOption('19:00');
  await page.locator('#waitlist-consent').check();
  await page.getByRole('button', { name: 'Entra in lista d’attesa' }).click();
  await expect(page.getByRole('heading', { name: 'Sei in lista d’attesa' })).toBeVisible();
  await expect(page.getByText('Non hai ancora un tavolo prenotato')).toBeVisible();
  expect(registrations).toBe(1);
});

test('offer token is immediately removed from URL and acceptance is confirmed only by server', async ({
  page,
}) => {
  const token = 'a'.repeat(64);
  let acceptances = 0;
  await page.route('**/rest/v1/rpc/get_public_site', (route) => route.fulfill({ json: site }));
  await page.route('**/functions/v1/waitlist', async (route) => {
    acceptances++;
    const body = route.request().postDataJSON();
    expect(body).toMatchObject({ action: 'ACCEPT', entry_id: entryId, access_token: token });
    await route.fulfill({
      json: {
        entry_id: entryId,
        status: 'CONVERTED_TO_RESERVATION',
        reservation_id: '10000000-0000-4000-8000-000000000004',
        reservation_status: 'RESERVED',
        offered_time: '19:00:00',
        deposit: null,
      },
    });
  });
  await page.goto(`http://localhost:5173/lista-attesa/offerta#entry=${entryId}&token=${token}`);
  await expect(page).toHaveURL('http://localhost:5173/lista-attesa/offerta');
  await expect(
    page.getByRole('heading', { name: 'Un posto potrebbe essersi liberato' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Accetta il posto proposto' }).click();
  await expect(page.getByRole('heading', { name: 'Prenotazione confermata' })).toBeVisible();
  expect(acceptances).toBe(1);
});

test('a malformed offer link cannot invoke a privileged acceptance', async ({ page }) => {
  let acceptances = 0;
  await page.route('**/rest/v1/rpc/get_public_site', (route) => route.fulfill({ json: site }));
  await page.route('**/functions/v1/waitlist', (route) => {
    acceptances++;
    return route.fulfill({ status: 403, json: { code: 'WAITLIST_ACCESS_DENIED' } });
  });
  await page.goto('http://localhost:5173/lista-attesa/offerta#entry=forged&token=invalid');
  await expect(page).toHaveURL('http://localhost:5173/lista-attesa/offerta');
  await expect(page.getByText('Link non valido')).toBeVisible();
  expect(acceptances).toBe(0);
});
