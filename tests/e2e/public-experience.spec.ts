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
  reservations_enabled: false,
};
const site = {
  name: 'Osteria Test',
  branding: { dark_mode: true },
  content: {},
  contact: {},
  multi_venue: false,
  venues: [venue],
};
const dishId = '40000000-0000-4000-8000-000000000007';
const categoryId = '40000000-0000-4000-8000-000000000008';
const menuPayload = {
  venue_id: venue.id,
  menu: {
    public_menu_id: '40000000-0000-4000-8000-000000000009',
    slug: 'cena',
    name: 'Carta della cena',
  },
  categories: [
    {
      id: categoryId,
      name: 'Primi',
      items: [
        {
          id: dishId,
          name: 'Risotto allo zafferano',
          description: 'Riso Carnaroli',
          image_path: null,
          beverage: false,
          price_cents: 1800,
          availability: 8,
          ingredients: [
            { id: '40000000-0000-4000-8000-000000000010', name: 'Burro', removable: true },
          ],
          allergens: [{ code: 'MILK', name: 'Latte' }],
          dietary_tags: [],
        },
      ],
    },
  ],
  promotions: [
    {
      id: '40000000-0000-4000-8000-000000000011',
      display_mode: 'CARD',
      title: 'La nostra proposta',
      body: 'Una specialità da assaggiare',
      image_path: null,
      cta_label: 'Scopri il piatto',
      priority: 5,
      max_impressions_per_session: null,
      target: { type: 'DISH', id: dishId },
    },
  ],
};

test('light mode is default despite restaurant dark branding, dark preference survives reload', async ({
  page,
}) => {
  await page.route('**/rest/v1/rpc/get_public_site', (route) => route.fulfill({ json: site }));
  await page.goto('http://localhost:5173/');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.getByRole('button', { name: 'Attiva tema scuro' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.getByRole('button', { name: 'Attiva tema chiaro' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
});

test('published menu has promotional carousel, photographic cards and accessible dish details', async ({
  page,
}) => {
  await page.route('**/rest/v1/rpc/get_public_site', (route) => route.fulfill({ json: site }));
  await page.route('**/rest/v1/rpc/get_public_menu_by_slug', (route) =>
    route.fulfill({ json: menuPayload }),
  );
  await page.goto('http://localhost:5173/menu/cena');
  await expect(page.getByRole('heading', { name: 'Carta della cena' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Le nostre proposte' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'La nostra proposta' })).toBeVisible();
  await expect(page.locator('.public-dish-card')).toHaveCount(1);
  await page.getByRole('link', { name: 'Dettagli e ingredienti' }).click();
  await expect(page.getByRole('heading', { name: 'Risotto allo zafferano' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Ingredienti' })).toBeVisible();
  await expect(page.getByText('Non serve creare un account.')).toBeVisible();
  await page.getByRole('link', { name: 'Torna alla carta' }).click();
  await expect(page.getByRole('heading', { name: 'Carta della cena' })).toBeVisible();
});

test('public menu survives an unavailable optional card index and keeps dish photos inside cards', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.route('**/rest/v1/rpc/get_public_site', (route) => route.fulfill({ json: site }));
  await page.route('**/rest/v1/rpc/get_public_navigation', (route) =>
    route.fulfill({ status: 503, json: { message: 'temporarily unavailable' } }),
  );
  const dish = {
    id: dishId,
    name: 'Risotto allo zafferano',
    description: 'Riso Carnaroli',
    image_path: 'https://images.example.test/risotto.jpg',
    beverage: false,
    category_id: categoryId,
    category_name: 'Primi',
    price_cents: 1800,
    availability: 8,
    ingredients: [
      { id: '40000000-0000-4000-8000-000000000013', name: 'Riso Carnaroli', removable: false },
    ],
    allergens: [],
    dietary_tags: [],
    variant_groups: [],
  };
  await page.route('**/rest/v1/rpc/get_public_menu', (route) =>
    route.fulfill({
      json: [dish, { ...dish, id: '40000000-0000-4000-8000-000000000012', name: 'Pasta fresca' }],
    }),
  );
  await page.route('**/risotto.jpg', (route) =>
    route.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><rect width="400" height="300" fill="#ddd"/></svg>',
    }),
  );
  await page.goto('http://localhost:5173/menu');
  await expect(page.getByRole('heading', { name: 'Risotto allo zafferano' })).toBeVisible();
  const card = page.locator('.public-legacy-dish').first();
  const photo = card.locator('img');
  await expect(photo).toBeVisible();
  await expect(card.getByText('Riso Carnaroli')).toHaveCount(1);
  const cardBox = await card.boundingBox();
  const imageBox = await photo.boundingBox();
  expect(cardBox).not.toBeNull();
  expect(imageBox).not.toBeNull();
  expect(Math.abs(imageBox!.x - cardBox!.x)).toBeLessThanOrEqual(2);
  expect(Math.abs(imageBox!.width - cardBox!.width)).toBeLessThanOrEqual(3);
  await page.screenshot({ path: 'test-results/perizia-menu-layout.png', fullPage: true });
});
