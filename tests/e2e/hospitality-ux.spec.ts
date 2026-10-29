import { expect, test } from '@playwright/test';

const venue = {
  id: '10000000-0000-4000-8000-000000000001',
  name: 'Osteria di prova',
  slug: 'osteria',
  address: 'Via del Centro 12',
  phone: '+390000000000',
  email: null,
  opening_hours: {},
  timezone: 'Europe/Rome',
  currency: 'EUR',
  locale: 'it-IT',
  reservations_enabled: false,
};
const site = {
  name: 'Osteria di prova',
  branding: {},
  content: {
    hero_title: 'Cucina fatta per stare insieme.',
    hero_subtitle: 'Piatti sinceri, ingredienti di stagione e il piacere di ritrovarsi.',
    story_title: 'La nostra storia',
    story: 'I gesti semplici, le persone e la passione per la cucina.',
  },
  contact: {},
  multi_venue: false,
  venues: [venue],
};
async function restaurantFixture(page: import('@playwright/test').Page) {
  await page.route('**/rest/v1/rpc/get_public_site', (route) => route.fulfill({ json: site }));
  await page.route('**/rest/v1/rpc/get_public_menu', (route) => route.fulfill({ json: [] }));
  await page.route('**/rest/v1/rpc/get_public_navigation', (route) => route.fulfill({ json: { menus: [] } }));
}

for (const width of [390, 1280]) {
  test('editorial homepage structure and light/dark mode at ' + width, async ({ page }) => {
    await page.setViewportSize({ width, height: 850 });
    await restaurantFixture(page);
    await page.goto('http://localhost:5173/');
    const hero = page.locator('.restaurant-welcome');
    const journeys = page.locator('.restaurant-journey-bar a');
    const menu = page.locator('.restaurant-discover');
    const hospitality = page.locator('.restaurant-home-content');
    await expect(hero).toBeVisible();
    await expect(journeys).toHaveCount(3);
    await expect(menu).toBeVisible();
    await expect(hospitality.locator('.restaurant-story-panel')).toBeVisible();
    await expect(hospitality.locator('.restaurant-visit-panel')).toBeVisible();
    const order = await page.locator('.restaurant-home > *').evaluateAll((nodes) =>
      nodes.map((node) => node.className)
    );
    expect(order.slice(0, 4)).toEqual([
      'restaurant-welcome',
      'restaurant-journey-bar',
      'restaurant-discover',
      'restaurant-home-content',
    ]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.screenshot({ path: 'test-results/hospitality-home-' + width + '-light.png', fullPage: true });
    await page.getByRole('button', { name: 'Attiva tema scuro' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.screenshot({ path: 'test-results/hospitality-home-' + width + '-dark.png', fullPage: true });
  });

  test('staff editorial login layout stays usable at ' + width, async ({ page }) => {
    await page.setViewportSize({ width, height: 850 });
    await page.goto('http://localhost:5174/');
    await expect(page.getByRole('heading', { name: 'Bentornato.' })).toBeVisible();
    await expect(page.locator('.login-story')).toBeVisible();
    await expect(page.getByLabel('Identificativo staff')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.screenshot({ path: 'test-results/hospitality-staff-' + width + '.png', fullPage: true });
  });
}
