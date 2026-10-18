import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { password, sql, staff } from './stack/seed.mjs';
import { reset } from './stack/stack.mjs';

// STEP 11 on the disposable local stack: the public site reads real data through PostgREST as
// anon. Covered here: pages, responsive layout, essential SEO/accessibility structure, menu with
// allergens, no staff entry point, and Admin branding changes reaching the public site.
// Not covered (Edge Functions not served): asset upload, online booking submission, telemetry.

const publicBase = 'http://localhost:5173';
const pages = ['/', '/menu', '/ristorante', '/gallery', '/contatti', '/sedi'];

async function structure(page: Page) {
  return page.evaluate(() => ({
    lang: document.documentElement.lang,
    h1: document.querySelectorAll('h1').length,
    main: document.querySelectorAll('main#main').length,
    skip: document.querySelector('a[href="#main"]')?.textContent ?? '',
    description: document.querySelector('meta[name="description"]')?.getAttribute('content') ?? '',
    overflow: document.documentElement.scrollWidth > window.innerWidth,
    unlabeled: [...document.querySelectorAll('input,select,textarea')].filter(
      (input) =>
        !(input as HTMLInputElement).labels?.length &&
        !input.getAttribute('aria-label') &&
        (input as HTMLInputElement).type !== 'hidden',
    ).length,
    missingAlt: [...document.querySelectorAll('img')].filter((img) => !img.hasAttribute('alt'))
      .length,
    staffLinks: [...document.querySelectorAll('a')].filter((link) =>
      /staff/i.test(`${link.textContent} ${link.getAttribute('href')}`),
    ).length,
  }));
}

test.beforeEach(async () => {
  await reset();
});

for (const viewport of [
  { name: 'desktop', width: 1280, height: 900 },
  { name: 'mobile', width: 390, height: 844 },
]) {
  test(`sito pubblico ${viewport.name}: pagine, struttura accessibile, SEO e nessun accesso staff`, async ({
    browser,
  }) => {
    const page = await (
      await browser.newContext({ viewport: { width: viewport.width, height: viewport.height } })
    ).newPage();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    for (const path of pages) {
      await page.goto(publicBase + path);
      await expect(page.locator('main#main')).toBeVisible();
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      const result = await structure(page);
      expect(result, path).toMatchObject({
        lang: 'it',
        h1: 1,
        main: 1,
        overflow: false,
        unlabeled: 0,
        missingAlt: 0,
        staffLinks: 0,
      });
      expect(result.skip, path).toContain('Vai al contenuto');
      expect(await page.title(), path).toContain('Trattoria E2E');
    }
    expect(errors).toEqual([]);

    // Menu pubblico dal catalogo reale, con prezzo in euro e allergeni dagli ingredienti.
    await page.goto(`${publicBase}/menu`);
    const carbonara = page.locator('article', { hasText: 'Carbonara' }).first();
    await expect(carbonara).toContainText('14,00 €');
    await expect(carbonara).toContainText('Contiene: Uova');
    // Prenotazioni disattivate: messaggio chiaro, nessun modulo.
    await page.goto(`${publicBase}/prenota`);
    await expect(page.getByText('Prenotazioni online non disponibili')).toBeVisible();
    await expect(page.locator('form')).toHaveCount(0);
  });
}

test('branding Admin: colore, testi e sezioni arrivano al sito pubblico', async ({ browser }) => {
  const admin = await (await browser.newContext()).newPage();
  await admin.goto('/login');
  await admin.getByLabel('Identificativo staff').fill(staff.admin.email);
  await admin.getByLabel('Password').fill(password);
  await admin.getByRole('button', { name: 'Accedi al servizio' }).click();
  await expect(admin.getByText(`${staff.admin.name} · ADMIN`)).toBeVisible();
  await admin.goto('/sito');
  await admin.getByLabel('Colore principale').fill('#2a6f4e');
  await admin.getByLabel('Titolo iniziale', { exact: true }).fill('Cucina di quartiere dal 1998');
  await admin.getByLabel('Titolo SEO', { exact: true }).fill('Trattoria E2E · Milano');
  await admin
    .getByLabel('Descrizione SEO', { exact: true })
    .fill('Trattoria milanese con cucina di stagione.');
  await admin.getByLabel('Mostra gallery').uncheck();
  // Un verde scuro su sfondo scuro non è leggibile: il server lo rifiuta, la UI lo spiega prima.
  await admin.getByRole('button', { name: 'Salva sito e branding' }).click();
  await expect(admin.getByText(/non ha contrasto sufficiente con lo sfondo/)).toBeVisible();
  expect(sql(`select coalesce(branding->>'accent_color','') from public.restaurant_profile`)).toBe(
    '',
  );
  await admin.getByLabel('Colore principale').fill('#7fd1a8');
  await admin.getByRole('button', { name: 'Salva sito e branding' }).click();
  await expect(admin.getByText('Sito aggiornato.')).toBeVisible();
  expect(sql(`select branding->>'accent_color' from public.restaurant_profile`)).toBe('#7fd1a8');

  const visitor = await (await browser.newContext()).newPage();
  await visitor.goto(publicBase + '/');
  await expect(visitor.getByRole('heading', { level: 1 })).toContainText(
    'Cucina di quartiere dal 1998',
  );
  await expect
    .poll(() =>
      visitor.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue('--accent'),
      ),
    )
    .toContain('#7fd1a8');
  await expect(visitor.getByRole('link', { name: 'Gallery' })).toHaveCount(0);
});
