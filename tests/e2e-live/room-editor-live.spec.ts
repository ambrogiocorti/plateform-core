import { expect, test } from '@playwright/test';
import { ids, password, sql, staff } from './stack/seed.mjs';
import { reset } from './stack/stack.mjs';

// The simple room editor: an Admin adds a table without aiming at the canvas, and one Salva both
// stores the room and puts it in use.

test.beforeEach(async () => {
  await reset();
  sql(`update public.feature_flags set licensed=true where name='ADVANCED_ROOM_EDITOR'`);
  sql(`update public.room_layouts set active=false where id='${ids.layout}'`);
});

test('adds a table and one Salva stores the room and puts it in use', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Identificativo staff').fill(staff.admin.email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Accedi al servizio' }).click();
  await expect(page.getByText(`${staff.admin.name} · ADMIN`)).toBeVisible();
  await page.goto('/editor');
  await expect(page.getByText('Trascina un tavolo per spostarlo.', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Muro' })).toBeHidden();
  await page.getByRole('button', { name: 'Aggiungi tavolo' }).click();
  await expect(page.getByLabel('Numero tavolo')).toHaveValue('3');
  await page.getByRole('spinbutton', { name: 'Posti' }).fill('10');
  await page.getByRole('button', { name: 'Applica modifiche' }).click();
  await page.getByRole('button', { name: 'Salva', exact: true }).click();
  await expect(page.getByText('Sala salvata e messa in uso.')).toBeVisible();
  expect(
    sql(
      `select count(*)||':'||max(seats) from public.tables where layout_id='${ids.layout}' and active`,
    ),
  ).toBe('3:10');
  expect(sql(`select active from public.room_layouts where id='${ids.layout}'`)).toBe('t');
  // A second save after activation must not trip over the bumped layout version.
  await page.getByRole('button', { name: 'Aggiungi tavolo' }).click();
  await page.getByRole('button', { name: 'Salva', exact: true }).click();
  await expect(page.getByText('Sala salvata.')).toBeVisible();
  expect(sql(`select count(*) from public.tables where layout_id='${ids.layout}' and active`)).toBe(
    '4',
  );
});
