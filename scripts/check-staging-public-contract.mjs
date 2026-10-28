// Public GitHub Pages smoke: READ-ONLY RPC using the same staging key as the browser.
const root = process.env.VITE_SUPABASE_URL;
const key = process.env.VITE_SUPABASE_PUBLISHABLE_KEY;
if (process.env.PAGES_MODE !== 'test') {
  console.log('PUBLIC_STAGING_CONTRACT=NOT_APPLICABLE');
  process.exit(0);
}
if (!root || !key) throw Error('PUBLIC_STAGING_BINDING_MISSING');
const url = new URL(root);
if (url.protocol !== 'https:' || !url.hostname.endsWith('.supabase.co')) {
  throw Error('INVALID_STAGING_PROJECT_URL');
}
const response = await fetch(new URL('/rest/v1/rpc/get_public_site', root), {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    apikey: key,
    ...(key.startsWith('eyJ') ? { Authorization: 'Bearer ' + key } : {}),
  },
  body: '{}',
  signal: AbortSignal.timeout(12_000),
});
if (!response.ok) throw Error('PUBLIC_STAGING_RPC_FAILED:' + response.status);
const site = await response.json();
if (
  !site ||
  typeof site.name !== 'string' ||
  site.name.trim().length === 0 ||
  !Array.isArray(site.venues) ||
  site.venues.length === 0
) {
  throw Error('PUBLIC_STAGING_SITE_NOT_RENDERABLE');
}
console.log('PUBLIC_STAGING_CONTRACT=PASS');
console.log('PUBLIC_STAGING_VENUES=' + site.venues.length);
