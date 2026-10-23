import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join, resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { anonKey } from './stack/seed.mjs';

// STEP 8 PWA on a real release build of the staff app (not the dev server, where the service
// worker is disabled), served as static files against the disposable local stack. Covers install
// (service worker + manifest), the app shell loading with the network off, and the update flow
// between two releases: the new worker waits until staff choose to update, then takes over.

const root = resolve(import.meta.dirname, '../..');
const out = (release: string) => join(root, '.local/pwa-release', release);
const types: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
};

function build(release: string) {
  execFileSync(
    process.execPath,
    [
      join(root, 'node_modules/vite/bin/vite.js'),
      'build',
      '--config',
      'vite.staff.config.ts',
      '--outDir',
      out(release),
      '--emptyOutDir',
      '--logLevel',
      'error',
    ],
    {
      cwd: root,
      stdio: 'inherit',
      env: {
        ...process.env,
        VITE_ENVIRONMENT: 'development',
        VITE_RELEASE_VERSION: release,
        VITE_PUBLIC_BASE_URL: 'http://localhost:5173',
        VITE_STAFF_BASE_URL: `http://localhost:${port}`,
        VITE_SUPABASE_URL: 'http://127.0.0.1:54321',
        VITE_SUPABASE_PUBLISHABLE_KEY: anonKey,
      },
    },
  );
}

// Static server whose release can be switched, as a deploy would.
const port = 5175;
let current = '1.0.0';
let server: http.Server;

test.beforeAll(async () => {
  test.setTimeout(240_000);
  build('1.0.0');
  build('1.0.1');
  server = http.createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://localhost').pathname;
    let file = join(out(current), path);
    if (!existsSync(file) || statSync(file).isDirectory()) file = join(out(current), 'index.html');
    response.writeHead(200, {
      'content-type': types[extname(file)] ?? 'application/octet-stream',
      'cache-control': path === '/sw.js' ? 'no-cache' : 'no-store',
    });
    response.end(readFileSync(file));
  });
  await new Promise<void>((done) => server.listen(port, '127.0.0.1', done));
  expect((server.address() as AddressInfo).port).toBe(port);
});

test.afterAll(async () => {
  await new Promise((done) => server?.close(done));
});

test('PWA staff di rilascio: installazione, avvio senza rete e aggiornamento su richiesta', async ({
  browser,
}) => {
  const context = await browser.newContext({ serviceWorkers: 'allow' });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const base = `http://localhost:${port}`;

  // Installazione: manifest valido e service worker attivo che controlla la pagina.
  await page.goto(`${base}/login`);
  await expect(page.getByLabel('Identificativo staff')).toBeVisible();
  const manifest = await page.evaluate(async () => {
    const link = document.querySelector<HTMLLinkElement>('link[rel="manifest"]');
    return link ? ((await (await fetch(link.href)).json()) as Record<string, unknown>) : null;
  });
  expect(manifest).toMatchObject({ display: 'standalone', lang: 'it', start_url: '/' });
  // First activation claims the page and the app reloads itself once (controllerchange).
  await expect
    .poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller)).catch(() => false))
    .toBe(true);
  await page.waitForLoadState('load');
  await expect(page.getByLabel('Identificativo staff')).toBeVisible();
  const firstCache = await page.evaluate(async () => (await caches.keys()).join(','));
  expect(firstCache).toMatch(/^plateform-staff-[0-9a-f]{16}$/);

  // Senza rete: l'app si apre dalla cache e lo dice chiaramente, senza schermata bianca.
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByText('MODALITÀ OFFLINE')).toBeVisible();
  await expect(page.getByText('Accesso offline scaduto o non preparato')).toBeVisible();
  await context.setOffline(false);

  // Nuova release pubblicata: il nuovo worker aspetta finché lo staff non sceglie di aggiornare.
  current = '1.0.1';
  await page.goto(`${base}/login`);
  await page.evaluate(async () => {
    await (await navigator.serviceWorker.getRegistration())?.update();
  });
  await expect(page.getByText('È disponibile un aggiornamento.')).toBeVisible({
    timeout: 30_000,
  });
  expect(await page.evaluate(async () => (await caches.keys()).length)).toBe(2);
  await page.getByRole('button', { name: 'Aggiorna quando pronto' }).click();
  await expect
    .poll(
      () => page.evaluate(async () => (await caches.keys()).join(',')).catch(() => firstCache),
      {
        timeout: 30_000,
      },
    )
    .not.toBe(firstCache);
  await expect
    .poll(() => page.evaluate(async () => (await caches.keys()).length).catch(() => 0), {
      timeout: 30_000,
    })
    .toBe(1);
  await expect(page.getByLabel('Identificativo staff')).toBeVisible();
  expect(errors).toEqual([]);
});
