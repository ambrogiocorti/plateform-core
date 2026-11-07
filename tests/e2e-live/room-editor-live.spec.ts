import { expect, test } from '@playwright/test';
import { ids, password, sql, staff } from './stack/seed.mjs';
import { reset } from './stack/stack.mjs';

// The advanced room editor creates tables on its canvas, persists layout changes and activates
// the selected version separately; saving again after activation must use the new version.

test.beforeEach(async () => {
  await reset();
  sql(`update public.feature_flags set licensed=true where name='ADVANCED_ROOM_EDITOR'`);
  sql(`update public.room_layouts set active=false where id='${ids.layout}'`);
});

test('a table is added on the canvas, saved, activated and saved again', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Identificativo staff').fill(staff.admin.email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Accedi al servizio' }).click();
  await expect(page.locator('.workspace-subtitle')).toContainText(staff.admin.name);
  await expect(page.locator('.workspace-subtitle')).toContainText('admin');
  await page.goto('/editor');
  await expect(page.getByRole('button', { name: 'Muro' })).toBeVisible();
  await page.getByRole('button', { name: 'Tavolo', exact: true }).click();
  await page.locator('svg.room-canvas').click({ position: { x: 320, y: 220 } });
  await expect(page.getByLabel('Numero tavolo')).toHaveValue('3');
  await page.getByRole('spinbutton', { name: 'Posti' }).fill('10');
  await page.getByRole('button', { name: 'Applica proprietà' }).click();
  await page.getByRole('button', { name: 'Salva layout' }).click();
  await expect(page.getByText('Layout salvato.')).toBeVisible();
  await page.getByRole('button', { name: 'Attiva layout' }).click();
  await expect(page.getByText('Layout attivato.')).toBeVisible();
  expect(
    sql(
      `select count(*)||':'||max(seats) from public.tables where layout_id='${ids.layout}' and active`,
    ),
  ).toBe('3:10');
  expect(sql(`select active from public.room_layouts where id='${ids.layout}'`)).toBe('t');
  // A second save after activation must not trip over the bumped layout version.
  await page.getByRole('button', { name: 'Tavolo', exact: true }).click();
  await page.locator('svg.room-canvas').click({ position: { x: 440, y: 220 } });
  await page.getByRole('button', { name: 'Salva layout' }).click();
  await expect(page.getByText('Layout salvato.')).toBeVisible();
  expect(sql(`select count(*) from public.tables where layout_id='${ids.layout}' and active`)).toBe(
    '4',
  );
});
