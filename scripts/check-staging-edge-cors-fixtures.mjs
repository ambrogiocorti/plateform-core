import assert from 'node:assert/strict';
import { browserFacingEndpoints, verifyStagingEdgeCors } from './verify-staging-edge-cors.mjs';

const config = {
  origin: 'https://abcdefghijklmnopqrst.supabase.co',
  ref: 'abcdefghijklmnopqrst',
  productionRef: 'zyxwvutsrqponmlkjihg',
  publishableKey: 'sb_publishable_test_key',
  previewOrigin: 'https://plateform-preview.vercel.app',
};
let count = 0;
const check = (action) => {
  action();
  count++;
};

check(() => assert.equal(browserFacingEndpoints.length, 7));
const pass = await verifyStagingEdgeCors({
  ...config,
  fetcher: async () => ({
    status: 204,
    headers: new Headers({ 'Access-Control-Allow-Origin': config.previewOrigin }),
  }),
});
check(() => assert.equal(pass.passed, true));
check(() => assert.equal(pass.results.length, 7));
const deny = await verifyStagingEdgeCors({
  ...config,
  fetcher: async () => ({ status: 403, headers: new Headers() }),
});
check(() => assert.equal(deny.passed, false));
check(() =>
  assert.equal(
    deny.results.every((item) => !item.pass),
    true,
  ),
);
const mismatch = await verifyStagingEdgeCors({
  ...config,
  fetcher: async () => ({
    status: 204,
    headers: new Headers({ 'Access-Control-Allow-Origin': 'https://evil.example' }),
  }),
});
check(() => assert.equal(mismatch.passed, false));
await assert.rejects(
  verifyStagingEdgeCors({
    ...config,
    previewOrigin: 'http://127.0.0.1:5173',
  }),
  /PREVIEW_REQUIRES_EXACT_HTTPS_VERCEL_ORIGIN/,
);
count++;
console.log(`STAGING_EDGE_CORS_FIXTURES=PASS (${count} assertions)`);
