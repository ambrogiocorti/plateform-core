import assert from 'node:assert/strict';
import { verifyStaging } from './verify-staging-http.mjs';
const host = 'https://staging.example.org';
const backend = 'https://abdxvlykasqmknexxhjo.supabase.co';
const validHeaders = new Headers({
  'content-type': 'text/html',
  'x-robots-tag': 'noindex, nofollow',
  'content-security-policy':
    "default-src 'none'; script-src 'self'; connect-src 'self' https://abdxvlykasqmknexxhjo.supabase.co",
  'x-frame-options': 'DENY',
  'strict-transport-security': 'max-age=31536000',
});
const fixtures =
  (override = {}) =>
  async (url) => {
    const path = new URL(url).pathname;
    if (override[path]) return override[path];
    if (path === '/robots.txt')
      return new Response('User-agent: *\nDisallow: /\n', {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      });
    if (path === '/sitemap.xml' || path.includes('__plateform_missing'))
      return new Response('Not found', { status: 404 });
    const body = path.startsWith('/staff/')
      ? '<html><head><title>Plateform · Staff</title></head><body><main id="main">Accesso</main></body></html>'
      : '<html><head></head><body><main id="main">Ristorante</main></body></html>';
    return new Response(body, { status: 200, headers: validHeaders });
  };
let n = 0;
const check = async (fn) => {
  await fn();
  n++;
};
await check(async () =>
  assert.equal(
    (await verifyStaging({ origin: host, backendOrigin: backend, fetcher: fixtures() })).status,
    'PASS',
  ),
);
await check(
  async () =>
    await assert.rejects(
      () =>
        verifyStaging({
          origin: 'http://staging.plateform.test',
          backendOrigin: backend,
          fetcher: fixtures(),
        }),
      /HTTPS/,
    ),
);
await check(
  async () =>
    await assert.rejects(
      () =>
        verifyStaging({
          origin: 'https://plateform-test.example',
          backendOrigin: backend,
          fetcher: fixtures(),
        }),
      /UNDEPLOYED/,
    ),
);
await check(
  async () =>
    await assert.rejects(
      () =>
        verifyStaging({
          origin: host,
          backendOrigin: backend,
          fetcher: fixtures({
            '/': new Response('<html/>', { status: 200, headers: validHeaders }),
          }),
        }),
      /home_has_editorial_body/,
    ),
);
await check(
  async () =>
    await assert.rejects(
      () =>
        verifyStaging({
          origin: host,
          backendOrigin: backend,
          fetcher: fixtures({
            '/': new Response('<main id="main">Hello</main>', {
              status: 200,
              headers: new Headers({
                ...Object.fromEntries(validHeaders),
                'x-robots-tag': 'index,follow',
              }),
            }),
          }),
        }),
      /staging_noindex/,
    ),
);
await check(
  async () =>
    await assert.rejects(
      () =>
        verifyStaging({
          origin: host,
          backendOrigin: backend,
          fetcher: fixtures({
            '/staff/login': new Response('<html><main id="main">Wrong SPA</main></html>', {
              status: 200,
              headers: validHeaders,
            }),
          }),
        }),
      /staff_not_public_app/,
    ),
);
await check(
  async () =>
    await assert.rejects(
      () =>
        verifyStaging({
          origin: host,
          backendOrigin: backend,
          fetcher: async (url, options) => {
            const mock = await fixtures()(url, options);
            return url.includes('__plateform_missing')
              ? new Response('<main id="main"></main>', { status: 200 })
              : mock;
          },
        }),
      /missing_asset_404/,
    ),
);
console.log(`STEP11_STAGING_HTTP_SMOKE=PASS (${n}/${n} cases; no live deployment claimed)`);
