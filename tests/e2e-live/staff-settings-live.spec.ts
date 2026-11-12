import { expect, test } from '@playwright/test';
import { ids, password, sql, staff } from './stack/seed.mjs';
import { reset } from './stack/stack.mjs';

test.beforeEach(async () => {
  await reset();
});

test('service switches persist and six ordinary staff accounts need no repeated password', async ({
  page,
}) => {
  await page.goto('/login');
  await page.getByLabel('Identificativo staff').fill(staff.admin.email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Accedi al servizio' }).click();
  await expect(page.locator('.workspace-subtitle')).toContainText(staff.admin.name);
  await page.goto('/impostazioni');
  const switches = [
    'Prenotazioni online',
    'Il cliente può richiedere il conto',
    'Gestione piatti tornati indietro',
  ];
  for (const label of switches) await page.getByLabel(label, { exact: true }).check();
  await page.getByRole('button', { name: 'Salva flussi operativi', exact: true }).click();
  await expect(page.getByText('Flussi salvati e verificati.')).toBeVisible();
  await page.reload();
  for (const label of switches) await expect(page.getByLabel(label, { exact: true })).toBeChecked();
  expect(
    sql(
      `select reservations_enabled||':'||customer_bill_request||':'||returns_enabled from public.venue_settings where venue_id='${ids.venue}'`,
    ),
  ).toBe('true:true:true');
  await page.goto('/staff');
  for (let n = 1; n <= 6; n++) {
    await page.getByRole('button', { name: 'Aggiungi utente', exact: true }).click();
    const popup = page.getByRole('dialog', { name: 'Nuovo utente staff', exact: true });
    await popup.getByLabel('Nome e cognome', { exact: true }).fill(`Collega Cucina ${n}`);
    await popup
      .getByLabel('Identificativo staff', { exact: true })
      .fill(`collega${n}@staff.e2e.test`);
    await popup.getByLabel('Password iniziale', { exact: true }).fill(password);
    await popup.getByLabel('Ruolo', { exact: true }).selectOption('KITCHEN_STAFF');
    if (n === 1) {
      await page.setViewportSize({ width: 390, height: 844 });
      expect(await popup.evaluate((e) => e.scrollWidth <= e.clientWidth + 1)).toBe(true);
      await page.screenshot({ path: 'test-results/plateform-v5-staff-dialog-blue-mobile.png' });
      await page.setViewportSize({ width: 1280, height: 900 });
    }
    await popup.getByRole('button', { name: 'Crea utente', exact: true }).click();
    await expect(popup).toHaveCount(0);
    await expect(
      page.getByRole('heading', { name: `Collega Cucina ${n}`, exact: true }),
    ).toBeVisible();
    await expect(page.getByRole('dialog', { name: 'Conferma la tua identità' })).toHaveCount(0);
  }
  expect(
    sql(
      "select count(*) from public.staff_profiles p join auth.users u on u.id=p.id where u.email like 'collega%@staff.e2e.test' and p.active",
    ),
  ).toBe('6');
});
