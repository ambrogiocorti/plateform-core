import { expect, test } from '@playwright/test';
import { password, staff } from './stack/seed.mjs';
import { reset } from './stack/stack.mjs';

// Visual and functional evidence on the isolated stack, never on customer data.
// Screenshots are artifacts for design review, not a replacement for approval.
test.beforeEach(async () => {
  await reset();
});

test('workspace V5: redesigned access page remains usable on desktop and mobile', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1366, height: 900 });
  await page.goto('/login');
  await expect(page.getByRole('heading', { name: 'Bentornato.' })).toBeVisible();
  await expect(page.getByRole('heading', { name: /Più spazio al servizio/ })).toBeVisible();
  await expect(page.getByLabel('Identificativo staff')).toBeVisible();
  await expect(page.getByLabel('Password')).toBeVisible();
  await page.screenshot({ path: 'test-results/plateform-v5-login-desktop.png', fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('button', { name: 'Accedi al servizio' })).toBeVisible();
  const panel = await page.locator('.login-panel').evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { x: rect.x, right: rect.right, width: window.innerWidth };
  });
  expect(panel.x).toBeGreaterThanOrEqual(-1);
  expect(panel.right).toBeLessThanOrEqual(panel.width + 1);
  await page.screenshot({ path: 'test-results/plateform-v5-login-mobile.png', fullPage: true });
});

test('workspace V5: primary rail, authorized directory and mobile bottom navigation', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/login');
  await page.getByLabel('Identificativo staff').fill(staff.admin.email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Accedi al servizio' }).click();
  await expect(page.locator('.workspace-page-heading h1')).toHaveText('Operazioni');
  const nav = page.getByRole('navigation', { name: 'Aree principali' });
  await expect(nav.locator('a')).toHaveCount(6);
  await expect(nav.getByRole('link', { name: 'Sala' })).toBeVisible();
  await expect(nav.getByRole('link', { name: 'Cassa' })).toBeVisible();
  await expect(page.locator('.workspace-context-tabs')).toHaveCount(0);
  await expect(page.locator('.ops-overview')).toBeVisible();
  await expect(page.locator('.ops-summary-grid > button')).toHaveCount(4);
  const pseudoLogo = await page.locator('.sidebar-brand-row .brand').evaluate((brand) =>
    getComputedStyle(brand, '::before').content,
  );
  expect(pseudoLogo).toBe('none');
  await page.screenshot({ path: 'test-results/plateform-v5-admin-desktop.png', fullPage: true });

  await nav.getByRole('button', { name: 'Apri tutte le funzioni' }).click();
  const directory = page.getByRole('dialog', { name: 'Tutte le funzioni disponibili' });
  await expect(directory).toBeVisible();
  await expect(directory.getByRole('link', { name: /Menu della sede/ })).toBeVisible();
  await expect(directory.getByRole('link', { name: /Regole del servizio/ })).toBeVisible();
  await page.screenshot({ path: 'test-results/plateform-v5-directory.png' });
  await page.keyboard.press('Escape');
  await expect(directory).not.toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(nav.locator('a:visible')).toHaveCount(4);
  await expect(nav.getByRole('button', { name: 'Apri tutte le funzioni' })).toBeVisible();
  const bottom = await page.locator('.sidebar').evaluate((sidebar) => {
    const bounds = sidebar.getBoundingClientRect();
    return { bottom: bounds.bottom, viewport: window.innerHeight };
  });
  expect(Math.abs(bottom.bottom - bottom.viewport)).toBeLessThan(3);
  const topbar = await page.locator('.topbar-profile').evaluate((button) => {
    const rect = button.getBoundingClientRect();
    return { left: rect.left, right: rect.right, viewport: window.innerWidth };
  });
  expect(topbar.left).toBeGreaterThanOrEqual(0);
  expect(topbar.right).toBeLessThanOrEqual(topbar.viewport + 1);
  await page.screenshot({ path: 'test-results/plateform-v5-admin-mobile.png', fullPage: true });

  await nav.getByRole('button', { name: 'Apri tutte le funzioni' }).click();
  await directory.getByRole('link', { name: /Menu della sede/ }).click();
  await expect(page).toHaveURL(/\/menu-sede$/);
  await expect(page.locator('.workspace-page-heading h1')).toHaveText('Menu della sede');
});
