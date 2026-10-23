import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { anonKey, ids, sql, staff, supabaseUrl } from './stack.mjs';
import { device, mfaDevice } from './flow';

// File storage on hosted STAGING (real Supabase Storage + the asset-upload Edge Function):
// logo, gallery and dish photo from the Admin UI to a public URL serving the same bytes, content
// checks before storage, and no write to the buckets around the function. Staging keeps its
// data, so counts are compared before and after.
test.setTimeout(300_000);

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);
const jpeg = Buffer.from(
  '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=',
  'base64',
);
const publicUrl = new RegExp(
  `^${supabaseUrl.replaceAll('.', '\\.')}/storage/v1/object/public/(branding|gallery|dishes)/.+`,
);

async function upload(page: Page, purpose: string, name: string, mimeType: string, buffer: Buffer) {
  await page
    .getByLabel(`File: ${purpose}`, { exact: true })
    .setInputFiles({ name, mimeType, buffer });
  await page.getByRole('button', { name: `Carica file: ${purpose}` }).click();
}
const fetched = async (url: string) => Buffer.from(await (await fetch(url)).arrayBuffer());
const objects = () => Number(sql(`select count(*) from storage.objects`));
const uploads = () => Number(sql(`select count(*) from public.asset_uploads`));

test('storage: logo, galleria e foto piatto pubblicati; bucket chiusi fuori dalla funzione', async ({
  browser,
}) => {
  const admin = await mfaDevice(browser, staff.admin);
  const [objects0, uploads0] = [objects(), uploads()];
  await admin.goto('/sito');

  // Un file che non è davvero un'immagine viene rifiutato prima di arrivare allo storage.
  await upload(admin, 'logo', 'logo.png', 'image/png', Buffer.from('non sono un png'));
  await expect(admin.getByText('Il file non è un’immagine PNG, JPEG o WebP valida.')).toBeVisible();
  expect(objects()).toBe(objects0);

  await upload(admin, 'logo', 'logo.png', 'image/png', png);
  await expect(
    admin.getByText('File caricato. Salva la configurazione per pubblicarlo.'),
  ).toBeVisible();
  const logo = await admin.getByLabel('Logo', { exact: true }).inputValue();
  expect(logo).toMatch(publicUrl);
  await upload(admin, 'nuova foto della galleria', 'sala.jpg', 'image/jpeg', jpeg);
  await expect.poll(objects).toBe(objects0 + 2);
  // The page adds the photo to the gallery when the function answers, not when the object lands.
  await expect(admin.locator('img.asset-preview[src*="/public/gallery/"]').last()).toBeVisible();
  await admin.getByRole('button', { name: 'Salva sito e branding' }).click();
  await expect(admin.getByText('Sito aggiornato.')).toBeVisible();
  expect(sql(`select branding->>'logo_url' from public.restaurant_profile`)).toBe(logo);
  const gallery = sql(
    `select public_content->'gallery'->-1->>'url' from public.restaurant_profile`,
  );
  expect(gallery).toMatch(publicUrl);
  // Lo storage pubblico restituisce esattamente i byte caricati, senza autenticazione.
  expect((await fetched(logo)).equals(png)).toBe(true);
  expect((await fetched(gallery)).equals(jpeg)).toBe(true);

  // Foto del piatto, visibile nel menu pubblico (anon).
  await admin.goto('/gestione?modulo=dishes');
  await admin
    .locator('.configuration-row', { hasText: 'Carbonara' })
    .getByRole('button', { name: 'Modifica' })
    .click();
  const editor = admin.getByRole('dialog', { name: 'Modifica · Piatti e bevande' });
  await upload(admin, 'fotografia del piatto', 'carbonara.jpg', 'image/jpeg', jpeg);
  await expect(editor.getByLabel('Fotografia del piatto', { exact: true })).toHaveValue(publicUrl);
  await editor.getByRole('button', { name: 'Salva' }).click();
  await expect(admin.getByText('Configurazione salvata.')).toBeVisible();
  const photo = sql(`select image_path from public.dishes where name='Carbonara'`);
  expect(photo).toMatch(publicUrl);
  expect((await fetched(photo)).equals(jpeg)).toBe(true);
  const anon = anonKey();
  const menu = (await (
    await fetch(`${supabaseUrl}/rest/v1/rpc/get_public_menu`, {
      method: 'POST',
      headers: {
        apikey: anon,
        authorization: `Bearer ${anon}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ p_venue: ids.venue }),
    })
  ).json()) as { name: string; image_path: string | null }[];
  expect(menu.find((dish) => dish.name === 'Carbonara')?.image_path).toBe(photo);
  expect(uploads()).toBe(uploads0 + 3);

  // Scrittura diretta nello storage: rifiutata ad anonimi e allo staff; il cameriere non può
  // caricare nemmeno attraverso la funzione.
  const waiter = await device(browser, staff.waiter);
  const request = waiter.waitForRequest((entry) => entry.url().includes('/rest/v1/'));
  await waiter.reload();
  const staffAuthorization = (await request).headers()['authorization']!;
  for (const authorization of [`Bearer ${anon}`, staffAuthorization]) {
    const status = (
      await fetch(`${supabaseUrl}/storage/v1/object/branding/intruso.png`, {
        method: 'POST',
        headers: { apikey: anon, authorization, 'content-type': 'image/png' },
        body: png,
      })
    ).status;
    expect(status).toBeGreaterThanOrEqual(400);
  }
  const denied = await fetch(`${supabaseUrl}/functions/v1/asset-upload`, {
    method: 'POST',
    headers: {
      apikey: anon,
      authorization: staffAuthorization,
      'content-type': 'application/json',
      origin: 'http://localhost:5174',
    },
    body: JSON.stringify({
      bucket: 'gallery',
      resource_id: null,
      venue_id: null,
      mime: 'image/png',
      content_base64: png.toString('base64'),
      idempotency_key: crypto.randomUUID(),
    }),
  });
  expect(denied.status).toBeGreaterThanOrEqual(400);
  expect(sql(`select count(*) from storage.objects where name like '%intruso%'`)).toBe('0');
  expect(uploads()).toBe(uploads0 + 3);
});
