#!/usr/bin/env node
/** Read-only smoke test. Never books a table or initiates a payment. */
import { randomUUID } from 'node:crypto';

export async function verifyStaging({ origin, backendOrigin, fetcher = fetch }) {
  if (!origin || !backendOrigin) throw new Error('STAGING_ORIGIN_AND_BACKEND_REQUIRED');
  const website = new URL(origin),
    backend = new URL(backendOrigin);
  if (
    website.protocol !== 'https:' ||
    backend.protocol !== 'https:' ||
    website.origin !== origin ||
    backend.origin !== backendOrigin ||
    website.username ||
    backend.username ||
    website.password ||
    backend.password
  )
    throw new Error('STAGING_REQUIRES_EXACT_HTTPS_ORIGINS');
  if (
    website.hostname === 'localhost' ||
    website.hostname === '127.0.0.1' ||
    /\.(?:example|test|invalid|localhost)$/.test(website.hostname)
  )
    throw new Error('UNDEPLOYED_TEST_DOMAIN');
  const checks = [];
  const request = async (path) => {
    const response = await fetcher(website.origin + path, {
      redirect: 'manual',
      signal: AbortSignal.timeout(15000),
    });
    return { response, body: await response.text() };
  };
  const pass = (name, valid, detail) => {
    checks.push({ name, status: valid ? 'PASS' : 'FAIL' });
    if (!valid) throw new Error(`STAGING_SMOKE_FAILED:${name}:${detail}`);
  };
  const home = await request('/');
  pass('home_200', home.response.status === 200, home.response.status);
  pass('home_html', /text\/html/i.test(home.response.headers.get('content-type') || ''), 'MIME');
  pass('home_has_editorial_body', /<main[^>]+id="main"/.test(home.body), 'Missing editorial HTML');
  pass(
    'staging_noindex',
    /noindex/i.test(home.response.headers.get('x-robots-tag') || ''),
    'Indexable staging',
  );
  pass(
    'csp',
    (home.response.headers.get('content-security-policy') || '').includes("script-src 'self'") &&
      (home.response.headers.get('content-security-policy') || '').includes(backend.origin),
    'Missing CSP',
  );
  pass('frame_denied', home.response.headers.get('x-frame-options') === 'DENY', 'XFO');
  pass(
    'hsts',
    (home.response.headers.get('strict-transport-security') || '').includes('max-age='),
    'HSTS',
  );
  for (const route of ['/menu', '/contatti', '/staff/login']) {
    const page = await request(route);
    pass(
      `route_${route}`,
      page.response.status === 200 &&
        /text\/html/i.test(page.response.headers.get('content-type') || ''),
      page.response.status,
    );
    if (route.startsWith('/staff/')) {
      pass(
        'staff_not_public_app',
        page.body.includes('Plateform · Staff') &&
          !page.body.includes('id="restaurant-structured-data"'),
        'Wrong staff HTML',
      );
      pass(
        'staff_noindex',
        /noindex/i.test(page.response.headers.get('x-robots-tag') || ''),
        'Staff indexable',
      );
    }
  }
  for (const route of [
    `/assets/__plateform_missing_${randomUUID()}.js`,
    `/staff/assets/__plateform_missing_${randomUUID()}.js`,
  ]) {
    const unknown = await request(route);
    pass(
      'missing_asset_404',
      unknown.response.status === 404,
      `${route} ${unknown.response.status}`,
    );
  }
  const robots = await request('/robots.txt');
  pass('robots_200', robots.response.status === 200, robots.response.status);
  pass(
    'robots_staging_disallow',
    /Disallow: \/\s*$/m.test(robots.body),
    'Staging crawler exposure',
  );
  const sitemap = await request('/sitemap.xml');
  pass('staging_sitemap_absent', sitemap.response.status === 404, sitemap.response.status);
  return { status: 'PASS', tested_at: new Date().toISOString(), checks };
}
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  try {
    const report = await verifyStaging({
      origin: process.env.PLATEFORM_STAGING_ORIGIN,
      backendOrigin: process.env.VITE_SUPABASE_URL,
    });
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
