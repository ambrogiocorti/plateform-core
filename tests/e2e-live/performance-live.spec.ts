import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import http from 'node:http';
import { extname, join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { anonKey } from './stack/seed.mjs';
import { reset } from './stack/stack.mjs';

// Web performance of the release builds (not the dev servers), served compressed as a static
// host would, against the disposable local stack. Cold loads on an emulated mid-range phone:
// Lighthouse "Slow 4G" network (150 ms RTT, 1.6 Mbit/s) and 4x CPU slowdown. Budgets follow the
// Core Web Vitals "good" thresholds (LCP <= 2.5 s, CLS <= 0.1). The local API answers faster
// than a real Supabase region, so these numbers are a lower bound for production.

const root = resolve(import.meta.dirname, '../..');
const out = (app: string) => join(root, '.local/perf-release', app);
const ports = { public: 5176, staff: 5177 };
const types: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.json': 'application/json',
};
const servers: http.Server[] = [];

function build(app: 'public' | 'staff') {
  execFileSync(
    process.execPath,
    [
      join(root, 'node_modules/vite/bin/vite.js'),
      'build',
      '--config',
      `vite.${app}.config.ts`,
      '--outDir',
      out(app),
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
        VITE_RELEASE_VERSION: '1.0.0',
        VITE_PUBLIC_BASE_URL: `http://localhost:${ports.public}`,
        VITE_STAFF_BASE_URL: `http://localhost:${ports.staff}`,
        VITE_SUPABASE_URL: 'http://127.0.0.1:54321',
        VITE_SUPABASE_PUBLISHABLE_KEY: anonKey,
      },
    },
  );
}

function serve(app: 'public' | 'staff') {
  const server = http.createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://localhost').pathname;
    let file = join(out(app), path);
    if (!existsSync(file) || statSync(file).isDirectory()) file = join(out(app), 'index.html');
    const type = types[extname(file)] ?? 'application/octet-stream';
    let body = readFileSync(file);
    const headers: Record<string, string> = {
      'content-type': type,
      'cache-control': path.startsWith('/assets/')
        ? 'public, max-age=31536000, immutable'
        : 'no-cache',
    };
    if (!type.startsWith('image/png') && !type.startsWith('font/')) {
      body = gzipSync(body, { level: 9 });
      headers['content-encoding'] = 'gzip';
    }
    response.writeHead(200, headers);
    response.end(body);
  });
  servers.push(server);
  return new Promise<void>((done) => server.listen(ports[app], '127.0.0.1', done));
}

test.beforeAll(async () => {
  test.setTimeout(240_000);
  build('public');
  build('staff');
  await Promise.all([serve('public'), serve('staff')]);
});

test.afterAll(async () => {
  await Promise.all(servers.map((server) => new Promise((done) => server.close(done))));
});

test.beforeEach(async () => {
  await reset();
});

type Vitals = { lcp: number; cls: number; scriptKb: number; totalKb: number; requests: number };

async function coldLoad(page: Page, url: string, ready: () => Promise<void>): Promise<Vitals> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false,
    latency: 150,
    downloadThroughput: (1.6 * 1024 * 1024) / 8,
    uploadThroughput: (750 * 1024) / 8,
  });
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  await page.addInitScript(() => {
    const vitals = { lcp: 0, cls: 0 };
    (window as unknown as { __vitals: typeof vitals }).__vitals = vitals;
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) vitals.lcp = entry.startTime;
    }).observe({ type: 'largest-contentful-paint', buffered: true });
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries() as (PerformanceEntry & {
        value: number;
        hadRecentInput: boolean;
      })[])
        if (!entry.hadRecentInput) vitals.cls += entry.value;
    }).observe({ type: 'layout-shift', buffered: true });
  });
  await page.goto(url);
  await ready();
  await page.waitForLoadState('networkidle');
  return page.evaluate(() => {
    const resources = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
    const navigation = performance.getEntriesByType('navigation')[0] as PerformanceResourceTiming;
    const kb = (entries: PerformanceResourceTiming[]) =>
      Math.round(entries.reduce((sum, entry) => sum + entry.transferSize, 0) / 1024);
    const { lcp, cls } = (window as unknown as { __vitals: { lcp: number; cls: number } }).__vitals;
    return {
      lcp: Math.round(lcp),
      cls: Math.round(cls * 1000) / 1000,
      scriptKb: kb(resources.filter((entry) => entry.initiatorType === 'script')),
      totalKb: kb([...resources, navigation]),
      requests: resources.length + 1,
    };
  });
}

for (const [label, path, heading] of [
  ['home', '/', /./],
  ['menu', '/menu', /Il nostro menu/],
  ['prenota', '/prenota', /./],
] as const) {
  test(`velocità sito pubblico (telefono, 4G lenta): ${label}`, async ({ browser }) => {
    const page = await (
      await browser.newContext({
        viewport: { width: 390, height: 844 },
        isMobile: true,
        // First visit: no service worker yet (its first activation reloads the staff app).
        serviceWorkers: 'block',
      })
    ).newPage();
    const vitals = await coldLoad(page, `http://localhost:${ports.public}${path}`, () =>
      expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible(),
    );
    console.log(`[perf] pubblico ${label}`, JSON.stringify(vitals));
    expect(vitals.lcp).toBeGreaterThan(0);
    expect(vitals.lcp).toBeLessThanOrEqual(2500);
    expect(vitals.cls).toBeLessThanOrEqual(0.1);
    // Whole first load, compressed: a 2.4 MB icon once slipped in unnoticed.
    expect(vitals.totalKb).toBeLessThanOrEqual(300);
  });
}

test('velocità app staff (telefono, 4G lenta): accesso', async ({ browser }) => {
  const page = await (
    await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      // First visit: no service worker yet (its first activation reloads the staff app).
      serviceWorkers: 'block',
    })
  ).newPage();
  const vitals = await coldLoad(page, `http://localhost:${ports.staff}/login`, () =>
    expect(page.getByLabel('Identificativo staff')).toBeVisible(),
  );
  console.log('[perf] staff login', JSON.stringify(vitals));
  expect(vitals.lcp).toBeGreaterThan(0);
  expect(vitals.lcp).toBeLessThanOrEqual(2500);
  expect(vitals.cls).toBeLessThanOrEqual(0.1);
  expect(vitals.totalKb).toBeLessThanOrEqual(300);
});
