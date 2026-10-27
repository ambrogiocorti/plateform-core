import { expect, test } from '@playwright/test';

// Browser contract tests use explicit HTTP fixtures. They are not Supabase integration tests.
const venue = {
  id: '10000000-0000-4000-8000-000000000001',
  name: 'Ristorante di prova',
  slug: 'ristorante',
  address: 'Via di prova 1',
  phone: '+390000000001',
  email: null,
  opening_hours: { 'Lunedì – Sabato': '19:00 – 23:00' },
  timezone: 'Europe/Rome',
  currency: 'EUR',
  locale: 'it-IT',
  reservations_enabled: false,
};
const site = {
  name: 'Ristorante di prova',
  branding: {},
  content: {
    hero_title: 'Una cucina da ricordare.',
    hero_subtitle: 'Il piacere di ritrovarsi, attorno alla stessa tavola.',
    story_title: 'La nostra storia.',
    story: 'Una cucina legata al territorio e alla stagione.',
  },
  contact: {},
  multi_venue: false,
  venues: [venue],
};

test('staff root opens an accessible login and never displays a public restaurant selector', async ({
  page,
}) => {
  await page.goto('http://localhost:5174');
  await expect(page).toHaveURL('http://localhost:5174/login');
  await expect(page.getByRole('heading', { name: 'Bentornato.' })).toBeVisible();
  await expect(page.getByLabel('Identificativo staff')).toBeVisible();
  await expect(page.getByLabel('Password', { exact: true })).toHaveAttribute('type', 'password');
  await expect(page.getByRole('button', { name: 'Accedi al servizio' })).toBeVisible();
  await expect(page.getByRole('combobox')).toHaveCount(0);
  await page.screenshot({ path: 'test-results/staff-login.png', fullPage: true });
});

test('public home preserves the restaurant brand and hides disabled booking and staff entry', async ({
  page,
}) => {
  await page.route('**/rest/v1/rpc/get_public_site', (route) => route.fulfill({ json: site }));
  await page.goto('http://localhost:5173');
  await expect(page.getByRole('heading', { name: 'Una cucina da ricordare.' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Prenota', exact: true })).toHaveCount(0);
  await expect(page.getByRole('link', { name: /staff/i })).toHaveCount(0);
  await expect(page.getByRole('combobox')).toHaveCount(0);
  await page.screenshot({ path: 'test-results/public-home.png', fullPage: true });
});

test('menu renders allergen information and treats untrusted dish names as text', async ({
  page,
}) => {
  await page.route('**/rest/v1/rpc/get_public_site', (route) => route.fulfill({ json: site }));
  // The public menu now requests its published-card index before the dish catalog.
  await page.route('**/rest/v1/rpc/get_public_navigation', (route) =>
    route.fulfill({ json: { menus: [] } }),
  );
  await page.route('**/rest/v1/rpc/get_public_menu', (route) =>
    route.fulfill({
      json: [
        {
          id: '40000000-0000-4000-8000-000000000001',
          category_id: '40000000-0000-4000-8000-000000000002',
          name: '<img src=x onerror=alert(1)>',
          category_name: 'Primi',
          description: 'Pasta fresca',
          image_path: null,
          beverage: false,
          price_cents: 1800,
          availability: 0,
          ingredients: [
            { id: '40000000-0000-4000-8000-000000000003', name: 'Pecorino', removable: false },
          ],
          allergens: [{ code: 'MILK', name: 'Latte' }],
          dietary_tags: [],
          variant_groups: [],
        },
      ],
    }),
  );
  await page.goto('http://localhost:5173/menu');
  await expect(page.getByRole('heading', { name: '<img src=x onerror=alert(1)>' })).toBeVisible();
  await expect(page.getByText('Contiene: Latte')).toBeVisible();
  await expect(page.getByText('Esaurito', { exact: true })).toBeVisible();
  await expect(page.locator('article img')).toHaveCount(0);
});

test('public phone layout stays within the viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route('**/rest/v1/rpc/get_public_site', (route) => route.fulfill({ json: site }));
  await page.goto('http://localhost:5173');
  await expect(page.getByRole('heading', { name: 'Una cucina da ricordare.' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({ path: 'test-results/public-mobile.png', fullPage: true });
});

test('redesigned menu supports responsive category navigation and live dish search', async ({
  page,
}) => {
  await page.route('**/rest/v1/rpc/get_public_site', (route) => route.fulfill({ json: site }));
  await page.route('**/rest/v1/rpc/get_public_navigation', (route) =>
    route.fulfill({ json: { menus: [] } }),
  );
  await page.route('**/rest/v1/rpc/get_public_menu', (route) =>
    route.fulfill({
      json: ['Ravioli al basilico', 'Tiramisu della casa'].map((name, index) => ({
        id: `40000000-0000-4000-8000-00000000000${index + 1}`,
        category_id: '40000000-0000-4000-8000-000000000005',
        name,
        category_name: index === 0 ? 'Primi' : 'Dolci',
        description: index === 0 ? 'Pasta fresca' : 'Crema e caffè',
        image_path: null,
        beverage: false,
        price_cents: index === 0 ? 1800 : 700,
        availability: 0,
        ingredients: [],
        allergens: [],
        dietary_tags: [],
        variant_groups: [],
      })),
    }),
  );
  await page.goto('http://localhost:5173/menu');
  await expect(page.getByRole('searchbox', { name: 'Cerca nel menu' })).toBeVisible();
  await expect(page.locator('.dish-public:visible')).toHaveCount(2);
  await page.getByRole('searchbox', { name: 'Cerca nel menu' }).fill('Tiramisu');
  await expect(page.locator('.dish-public:visible')).toHaveCount(1);
  await expect(page.getByRole('heading', { name: 'Ravioli al basilico' })).toBeHidden();
  await expect(page.getByRole('heading', { name: 'Tiramisu della casa' })).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: '1 proposta' })).toBeVisible();
  await page.getByRole('searchbox', { name: 'Cerca nel menu' }).clear();
  await expect(page.locator('.dish-public:visible')).toHaveCount(2);
});

test('new mobile guest experience has distinct shortcuts without horizontal scrolling', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route('**/rest/v1/rpc/get_public_site', (route) => route.fulfill({ json: site }));
  await page.goto('http://localhost:5173');
  await expect(page.getByRole('heading', { name: 'Una cucina da ricordare.' })).toBeVisible();
  await expect(page.locator('.public-hero-visual')).toBeVisible();
  await expect(page.locator('.public-action-tile')).toHaveCount(2);
  const dock = page.getByRole('navigation', { name: 'Navigazione rapida' });
  await expect(dock).toBeInViewport();
  await expect(dock.getByRole('link', { name: 'Menu' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});

test('compact tablet navigation opens and Escape restores focus to its toggle', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.route('**/rest/v1/rpc/get_public_site', (route) => route.fulfill({ json: site }));
  await page.goto('http://localhost:5173');
  const menuToggle = page.getByRole('button', { name: 'Menu', exact: true });
  const nav = page.getByRole('navigation', { name: 'Principale' });
  await expect(menuToggle).toBeVisible();
  await menuToggle.click();
  await expect(nav).toBeVisible();
  await expect(menuToggle).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('Escape');
  await expect(menuToggle).toHaveAttribute('aria-expanded', 'false');
  await expect(menuToggle).toBeFocused();
  await expect(nav).toBeHidden();
});
