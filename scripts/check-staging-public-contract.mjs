// Public GitHub Pages smoke: read-only RPC using the same key as the browser.
// Kept at the existing path so older runbooks still locate the preflight.
const root = process.env.VITE_SUPABASE_URL;
const key = process.env.VITE_SUPABASE_PUBLISHABLE_KEY;
const expected = process.env.PLATEFORM_CHECK_PROJECT_REF;
if (!root || !key || !expected) throw Error('PUBLIC_BACKEND_BINDING_MISSING');
const url = new URL(root);
if (url.protocol !== 'https:' || url.hostname !== `${expected}.supabase.co`) {
  throw Error('PUBLIC_BACKEND_PROJECT_MISMATCH');
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
if (!response.ok) throw Error('PUBLIC_BACKEND_RPC_FAILED:' + response.status);
const site = await response.json();
if (
  !site ||
  typeof site.name !== 'string' ||
  site.name.trim().length === 0 ||
  !Array.isArray(site.venues) ||
  site.venues.length === 0
) {
  throw Error('PUBLIC_BACKEND_SITE_NOT_RENDERABLE');
}
console.log('PUBLIC_BACKEND_CONTRACT=PASS');
console.log('PUBLIC_BACKEND_PROJECT=' + expected);
console.log('PUBLIC_BACKEND_VENUES=' + site.venues.length);
