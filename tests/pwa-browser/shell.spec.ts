import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

async function waitForActiveWorker(page: Page) {
  await expect
    .poll(async () => {
      try {
        return await page.evaluate(() => navigator.serviceWorker.controller?.state ?? null);
      } catch (error) {
        // An unauthenticated page may redirect while the service worker activates.
        if (String(error).includes('Execution context was destroyed')) return null;
        throw error;
      }
    })
    .toBe('activated');
}

const applications = [
  { label: 'public', origin: 'http://127.0.0.1:4173', offlineRoute: '/menu' },
  { label: 'staff', origin: 'http://127.0.0.1:4174', offlineRoute: '/servizio' },
] as const;

for (const application of applications) {
  test(`${application.label} production PWA installs a real service worker and survives offline navigation`, async ({
    page,
    context,
  }) => {
    await page.goto(application.origin + '/', { waitUntil: 'domcontentloaded' });
    await waitForActiveWorker(page);

    const details = await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.ready;
      const response = await fetch('/manifest.webmanifest');
      return {
        worker: registration.active?.scriptURL,
        scope: registration.scope,
        manifest: await response.json(),
        caches: await caches.keys(),
      };
    });
    expect(details.worker).toBe(application.origin + '/sw.js');
    expect(details.scope).toBe(application.origin + '/');
    expect(details.manifest.scope).toBe('/');
    expect(details.manifest.start_url).toBe('/');
    expect(
      details.caches.some((key: string) => key.startsWith(`plateform-${application.label}-`)),
    ).toBe(true);

    await context.setOffline(true);
    const response = await page.goto(application.origin + application.offlineRoute, {
      waitUntil: 'domcontentloaded',
    });
    expect(response?.status()).toBe(200);
    await expect(page.locator('#app')).toHaveCount(1);
  });
}

test('staff offline shell does not emulate a successful financial POST', async ({
  page,
  context,
}) => {
  await page.goto('http://127.0.0.1:4174/', { waitUntil: 'domcontentloaded' });
  await waitForActiveWorker(page);
  await context.setOffline(true);
  const executed = await page.evaluate(async () => {
    try {
      await fetch('/rest/v1/rpc/create_payment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      return true;
    } catch {
      return false;
    }
  });
  expect(executed).toBe(false);
});
