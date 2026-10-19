import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';
import { anonKey, ids, password, sql, stack, staff } from './stack/seed.mjs';
import { reset } from './stack/stack.mjs';

// STEP 11 asset upload on the disposable local stack with the real Supabase storage-api (file
// backend, run by the stack when Docker is available) behind the gateway, and the repository's
// asset-upload Edge Function. Covers logo, gallery and dish photos from the Admin UI to the
// public URL and its rendering on the public site, content checks, and that nobody can write to
// the buckets around the function. Asset URLs must be https://: the stack's gateway also listens
// on HTTPS with a self-signed certificate, which only these browser contexts accept.

const storageInfo = resolve(import.meta.dirname, '.stack/storage.json');
const realStorage =
  existsSync(storageInfo) && JSON.parse(readFileSync(storageInfo, 'utf8')).real === true;
test.skip(!realStorage, 'storage-api non attivo: serve Docker per lo stack locale');

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);
const jpeg = Buffer.from(
  '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=',
  'base64',
);
const publicUrl =
  /^https:\/\/127\.0\.0\.1:54320\/storage\/v1\/object\/public\/(branding|gallery|dishes)\/.+/;

const publicBase = 'http://localhost:5173';

type Member = (typeof staff)[keyof typeof staff];

async function signIn(browser: Browser, member: Member): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  page.on('pageerror', (error) => console.log(`[${member.role}] pageerror`, error.message));
  await page.goto('/login');
  await page.getByLabel('Identificativo staff').fill(member.email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Accedi al servizio' }).click();
  await expect(
    page.getByText(`${member.name} · ${member.role.replaceAll('_', ' ')}`),
  ).toBeVisible();
  return page;
}

async function upload(page: Page, purpose: string, name: string, mimeType: string, buffer: Buffer) {
  await page
    .getByLabel(`File: ${purpose}`, { exact: true })
    .setInputFiles({ name, mimeType, buffer });
  await page.getByRole('button', { name: `Carica file: ${purpose}` }).click();
}

// Same object through the plain-HTTP side of the gateway (Node does not trust the local certificate).
const fetched = async (url: string) =>
  Buffer.from(
    await (await fetch(url.replace('https://127.0.0.1:54320', stack.gateway))).arrayBuffer(),
  );
const rendered = (page: Page, src: string) =>
  page.evaluate(
    (source) =>
      [...document.images].some((image) => {
        // Lazy images load only near the viewport.
        if (image.src === source) image.scrollIntoView();
        return image.src === source && image.complete && image.naturalWidth > 0;
      }),
    src,
  );
const objects = () => sql(`select count(*) from storage.objects`);

test.beforeEach(async () => {
  await reset();
});

test('upload Admin: logo e galleria salvati nello storage e pubblicati con il sito', async ({
  browser,
}) => {
  const admin = await signIn(browser, staff.admin);
  await admin.goto('/sito');

  // Un file che non è davvero un'immagine viene rifiutato prima di arrivare allo storage.
  await upload(admin, 'logo', 'logo.png', 'image/png', Buffer.from('non sono un png'));
  await expect(admin.getByText('Il file non è un’immagine PNG, JPEG o WebP valida.')).toBeVisible();
  expect(objects()).toBe('0');
  expect(sql(`select count(*) from public.asset_uploads`)).toBe('0');

  await upload(admin, 'logo', 'logo.png', 'image/png', png);
  await expect(
    admin.getByText('File caricato. Salva la configurazione per pubblicarlo.'),
  ).toBeVisible();
  const logo = await admin.getByLabel('Logo', { exact: true }).inputValue();
  expect(logo).toMatch(publicUrl);
  await upload(admin, 'nuova foto della galleria', 'sala.jpg', 'image/jpeg', jpeg);
  await expect.poll(objects).toBe('2');
  await admin.getByRole('button', { name: 'Salva sito e branding' }).click();
  await expect(admin.getByText('Sito aggiornato.')).toBeVisible();

  expect(sql(`select branding->>'logo_url' from public.restaurant_profile`)).toBe(logo);
  const gallery = sql(`select public_content->'gallery'->0->>'url' from public.restaurant_profile`);
  expect(gallery).toMatch(publicUrl);
  // Lo storage restituisce esattamente i byte caricati, senza autenticazione (bucket pubblici).
  expect((await fetched(logo)).equals(png)).toBe(true);
  expect((await fetched(gallery)).equals(jpeg)).toBe(true);
  // Il visitatore vede logo e foto sul sito pubblico.
  const visitor = await (await browser.newContext({ ignoreHTTPSErrors: true })).newPage();
  await visitor.goto(`${publicBase}/gallery`);
  await expect.poll(() => rendered(visitor, gallery)).toBe(true);
  await expect.poll(() => rendered(visitor, logo)).toBe(true);
  expect(
    sql(
      `select string_agg(bucket||':'||status||':'||size_bytes,',' order by bucket) from public.asset_uploads`,
    ),
  ).toBe(`branding:SAVED:${png.length},gallery:SAVED:${jpeg.length}`);
  expect(
    sql(
      `select count(*) from storage.objects o join public.asset_uploads a on a.bucket=o.bucket_id and a.path=o.name`,
    ),
  ).toBe('2');
});

test('upload: foto del piatto sul menu pubblico; nessuno scrive nei bucket aggirando la funzione', async ({
  browser,
}) => {
  const admin = await signIn(browser, staff.admin);
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

  // Il menu pubblico (anon, PostgREST) espone la foto.
  const menu = (await (
    await fetch(`${stack.gateway}/rest/v1/rpc/get_public_menu`, {
      method: 'POST',
      headers: {
        apikey: anonKey,
        authorization: `Bearer ${anonKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ p_venue: ids.venue }),
    })
  ).json()) as { name: string; image_path: string | null }[];
  expect(menu.find((dish) => dish.name === 'Carbonara')?.image_path).toBe(photo);
  const visitor = await (await browser.newContext({ ignoreHTTPSErrors: true })).newPage();
  await visitor.goto(`${publicBase}/menu`);
  await expect.poll(() => rendered(visitor, photo)).toBe(true);

  // Scrittura diretta nello storage: rifiutata ad anonimi e allo staff (nessuna policy di insert).
  const waiter = await signIn(browser, staff.waiter);
  const request = waiter.waitForRequest((entry) => entry.url().includes('/rest/v1/'));
  await waiter.reload();
  const staffAuthorization = (await request).headers()['authorization']!;
  for (const authorization of [`Bearer ${anonKey}`, staffAuthorization]) {
    const status = (
      await fetch(`${stack.gateway}/storage/v1/object/branding/intruso.png`, {
        method: 'POST',
        headers: { apikey: anonKey, authorization, 'content-type': 'image/png' },
        body: png,
      })
    ).status;
    expect(status).toBeGreaterThanOrEqual(400);
  }
  // Il cameriere non può caricare file nemmeno attraverso la funzione.
  const denied = await fetch(`${stack.gateway}/functions/v1/asset-upload`, {
    method: 'POST',
    headers: {
      apikey: anonKey,
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
  expect(sql(`select count(*) from public.asset_uploads`)).toBe('1');
});
