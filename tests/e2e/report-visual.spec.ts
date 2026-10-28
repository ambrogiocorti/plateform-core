import { expect, test } from '@playwright/test';

// Isolated browser fixtures: no production/staging mutations or authentication.
const venue = {
  id: '10000000-0000-4000-8000-000000000001',
  name: 'Ristorante verifica',
  slug: 'ristorante',
  address: 'Via Test 1',
  phone: '+390000000000',
  email: null,
  opening_hours: {},
  timezone: 'Europe/Rome',
  currency: 'EUR',
  locale: 'it-IT',
  reservations_enabled: false,
};
const site = {
  name: 'Ristorante verifica',
  branding: {},
  content: {
    hero_title: 'La cucina che ci unisce',
    hero_subtitle: 'La nostra proposta per stare bene a tavola.',
    story_title: 'La nostra storia',
    story: 'Una cucina locale con ingredienti di stagione.',
  },
  contact: {},
  multi_venue: false,
  venues: [venue],
};

for (const width of [1280, 390]) {
  test('public UI displays responsive, readable theme and focus at ' + width + 'px', async ({ page }) => {
    await page.setViewportSize({ width, height: 840 });
    await page.route('**/rest/v1/rpc/get_public_site', (route) => route.fulfill({ json: site }));
    await page.route('**/rest/v1/rpc/get_public_menu', (route) => route.fulfill({ json: [] }));
    await page.route('**/rest/v1/rpc/get_public_navigation', (route) => route.fulfill({ json: { menus: [] } }));
    await page.goto('http://localhost:5173');
    await expect(page.getByRole('heading', { name: 'La cucina che ci unisce' })).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await expect(page.locator('.restaurant-home')).toBeVisible();
    await expect(page.locator('.restaurant-discover')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.screenshot({ path: 'test-results/report-public-' + width + '-light.png', fullPage: true });
    await page.getByRole('button', { name: 'Attiva tema scuro' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.screenshot({ path: 'test-results/report-public-' + width + '-dark.png', fullPage: true });
  });
}

for (const width of [1280, 390]) {
  test('staff login respects control borders and themes at ' + width + 'px', async ({ page }) => {
    await page.setViewportSize({ width, height: 840 });
    await page.goto('http://localhost:5174');
    await expect(page.getByRole('heading', { name: 'Bentornato.' })).toBeVisible();
    const input = page.getByLabel('Identificativo staff');
    await expect(input).toBeVisible();
    const state = await input.evaluate((element) => {
      const style = getComputedStyle(element);
      return { width: parseFloat(style.borderLeftWidth), color: style.borderLeftColor };
    });
    expect(state.width).toBeGreaterThanOrEqual(2);
    expect(state.color).not.toBe('rgba(0, 0, 0, 0)');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.screenshot({ path: 'test-results/report-staff-' + width + '-light.png', fullPage: true });
    await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
    const dark = await input.evaluate((element) => getComputedStyle(element).borderLeftColor);
    expect(dark).not.toBe(state.color);
    await page.screenshot({ path: 'test-results/report-staff-' + width + '-dark.png', fullPage: true });
  });
}
