import assert from 'node:assert/strict';
import {
  protectedEndpoints,
  validateStagingTarget,
  verifyStagingEdgeDenial,
} from './verify-staging-edge-denial.mjs';

const source = {
  origin: 'https://abcdefghijklmnopqrst.supabase.co',
  ref: 'abcdefghijklmnopqrst',
  productionRef: 'zyxwvutsrqponmlkjihg',
  publishableKey: 'sb_publishable_testing_not_a_secret',
};
let assertions = 0;
const check = (action) => {
  action();
  assertions++;
};

check(() => assert.equal(protectedEndpoints.length, 12));
check(() => assert.doesNotThrow(() => validateStagingTarget(source)));
check(() =>
  assert.throws(
    () => validateStagingTarget({ ...source, productionRef: source.ref }),
    /STAGING_AND_PRODUCTION_REFS_MUST_BE_DISTINCT/,
  ),
);
check(() =>
  assert.throws(
    () => validateStagingTarget({ ...source, origin: 'https://evil.example' }),
    /STAGING_ORIGIN_MISMATCH/,
  ),
);
check(() =>
  assert.throws(
    () => validateStagingTarget({ ...source, publishableKey: 'service_role_secret' }),
    /STAGING_PUBLISHABLE_KEY_REQUIRED/,
  ),
);

const visited = [];
const pass = await verifyStagingEdgeDenial({
  ...source,
  fetcher: async (url, init) => {
    visited.push({ url, init });
    return { status: 401 };
  },
});
check(() => assert.equal(pass.passed, true));
check(() => assert.equal(pass.results.length, 12));
check(() =>
  assert.equal(
    visited.every((v) => v.init.method === 'POST'),
    true,
  ),
);
check(() =>
  assert.equal(
    visited.every((v) => !v.init.headers.Authorization),
    true,
  ),
);
check(() =>
  assert.equal(
    visited.every((v) => v.url.startsWith(source.origin + '/functions/v1/')),
    true,
  ),
);
const bad = await verifyStagingEdgeDenial({
  ...source,
  fetcher: async (url) => ({ status: url.endsWith('/maintenance') ? 200 : 401 }),
});
check(() => assert.equal(bad.passed, false));
check(() =>
  assert.equal(bad.results.find((entry) => entry.function === 'maintenance')?.pass, false),
);

console.log(`STAGING_EDGE_DENIAL_FIXTURES=PASS (${assertions} assertions)`);
