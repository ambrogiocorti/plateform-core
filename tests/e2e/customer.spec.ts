import { expect, test } from '@playwright/test';

test('QR customer preserves a draft through reconciliation and submits the reviewed cart', async ({
  page,
}) => {
  const venueId = '10000000-0000-4000-8000-000000000001';
  const accountId = '40000000-0000-4000-8000-000000000011';
  const customerId = '20000000-0000-4000-8000-000000000013';
  const publicTable = '40000000-0000-4000-8000-000000000003';
  const dishId = '40000000-0000-4000-8000-000000000007';
  const venue = {
    id: venueId,
    name: 'Ristorante di prova',
    slug: 'ristorante',
    address: 'Via prova 1',
    phone: '+390000000001',
    email: null,
    opening_hours: {},
    timezone: 'Europe/Rome',
    currency: 'EUR',
    locale: 'it-IT',
    reservations_enabled: false,
  };
  let reads = 0;
  let submitted: Record<string, unknown> | null = null;
  const authUser = {
    id: customerId,
    aud: 'authenticated',
    role: 'authenticated',
    email: 'customer@customer.plateform.invalid',
    app_metadata: {},
    user_metadata: {},
  };
  await page.route('**/auth/v1/user', (route) => route.fulfill({ json: authUser }));
  await page.route('**/functions/v1/customer-session', (route) => {
    expect(route.request().postDataJSON()).toMatchObject({
      public_table_id: publicTable,
      code: '492815',
    });
    const token = `${Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')}.${Buffer.from(JSON.stringify({ sub: customerId, role: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.fixture`;
    return route.fulfill({ json: { access_token: token, refresh_token: 'fixture-refresh' } });
  });
  await page.route('**/rest/v1/rpc/**', async (route) => {
    const name = new URL(route.request().url()).pathname.split('/').at(-1);
    let data: unknown;
    if (name === 'get_public_site')
      data = {
        name: 'Ristorante di prova',
        branding: {},
        content: {},
        contact: {},
        multi_venue: false,
        venues: [venue],
      };
    else if (name === 'get_customer_account') {
      reads++;
      data = {
        id: accountId,
        name: 'Il nostro tavolo',
        covers: 2,
        venue_id: venueId,
        currency: 'EUR',
        locale: 'it-IT',
        balance: { total_cents: 0, remaining_cents: 0 },
        customer_ordering: 'WAITER_APPROVAL',
        bill_request_enabled: true,
        items: [],
        requests: submitted
          ? [
              {
                id: '40000000-0000-4000-8000-000000000015',
                status: 'PENDING',
                created_at: new Date().toISOString(),
              },
            ]
          : [],
      };
    } else if (name === 'get_public_menu')
      data = [
        {
          id: dishId,
          name: 'Risotto',
          description: 'La proposta della cucina',
          image_path: null,
          beverage: false,
          category_id: '40000000-0000-4000-8000-000000000006',
          category_name: 'Primi',
          price_cents: 1800,
          availability: null,
          ingredients: [],
          allergens: [],
          dietary_tags: [],
          variant_groups: [],
        },
      ];
    else if (name === 'create_customer_order_request') {
      submitted = route.request().postDataJSON() as Record<string, unknown>;
      data = { status: 'PENDING' };
    } else throw new Error(`Unexpected RPC ${name}`);
    await route.fulfill({ json: data });
  });
  await page.goto(`http://localhost:5173/tavolo/${publicTable}`);
  await page.getByLabel('Codice del conto').fill('492815');
  await page.getByRole('button', { name: 'Apri il mio conto' }).click();
  await expect(page.getByRole('heading', { name: 'Il nostro tavolo' })).toBeVisible();
  await page.getByRole('button', { name: 'Scegli', exact: true }).click();
  await page.getByLabel('Quantità', { exact: true }).fill('2');
  await page.getByRole('button', { name: 'Aggiungi al carrello' }).click();
  await expect(page.getByText('2 pietanze nel carrello')).toBeVisible();
  const before = reads;
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect.poll(() => reads).toBeGreaterThan(before);
  await expect(page.getByText('2 pietanze nel carrello')).toBeVisible();
  await page.getByRole('button', { name: 'Rivedi il carrello' }).click();
  await page.getByLabel('Risotto · quantità').fill('3');
  await expect(page.getByText('3 pietanze nel carrello')).toBeAttached();
  await page
    .getByRole('dialog', { name: 'Il tuo carrello' })
    .getByRole('button', { name: 'Chiudi', exact: true })
    .click();
  await expect(page.getByText('3 pietanze nel carrello')).toBeVisible();
  await page.getByRole('button', { name: 'Chiedi conferma al cameriere' }).click();
  await expect(
    page.getByText('Hai una richiesta d’ordine in attesa di conferma del cameriere.'),
  ).toBeVisible();
  expect(submitted).toMatchObject({
    p_account: accountId,
    p_items: [
      { dish_id: dishId, quantity: 3, step: 1, removed_ingredients: [], variant_options: [] },
    ],
  });
  await expect(page.getByText('Il carrello è vuoto')).toBeVisible();
});
