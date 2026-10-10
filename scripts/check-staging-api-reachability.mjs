import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyStagingApiReachability } from './verify-staging-api-reachability.mjs';

const ref = 'kghactswtabakkkbojmo';
const binding = { status: 'PASS', project_ref: ref };
const good = async (url, options) => {
  assert.equal(new URL(url).hostname, `${ref}.supabase.co`);
  assert.equal(options.method, 'GET');
  assert.equal(options.headers.apikey, 'sb_publishable_test_fixture');
  assert.equal(options.redirect, 'error');
  if (url.endsWith('/auth/v1/settings'))
    return Response.json({ disable_signup: true, external: {} });
  return Response.json({ swagger: '2.0', paths: {} });
};

test('passes a safe read-only Auth plus Data API probe on bound host', async () => {
  const result = await verifyStagingApiReachability(binding, {
    apiKey: 'sb_publishable_test_fixture',
    fetcher: good,
  });
  assert.equal(result.status, 'PASS');
  assert.equal(result.checks.length, 2);
});

test('refuses a missing project binding before attempting network', async () => {
  await assert.rejects(
    () =>
      verifyStagingApiReachability(null, {
        apiKey: 'sb_publishable_test_fixture',
        fetcher: good,
      }),
    /STAGING_UNVERIFIED_PROJECT_BINDING/,
  );
});

test('fails closed on project API 401 without logging any key', async () => {
  await assert.rejects(
    () =>
      verifyStagingApiReachability(binding, {
        apiKey: 'sb_publishable_test_fixture',
        fetcher: async () => Response.json({ error: 'Unauthorized' }, { status: 401 }),
      }),
    /STAGING_API_NOT_READY/,
  );
});

test('fails closed on Auth success but Data API failure', async () => {
  await assert.rejects(
    () =>
      verifyStagingApiReachability(binding, {
        apiKey: 'sb_publishable_test_fixture',
        fetcher: async (url, options) =>
          url.endsWith('/auth/v1/settings')
            ? good(url, options)
            : Response.json({ error: 'Offline' }, { status: 503 }),
      }),
    /STAGING_API_NOT_READY/,
  );
});

test('fails closed on HTML login, malformed Auth and malformed Data API body', async () => {
  await assert.rejects(
    () =>
      verifyStagingApiReachability(binding, {
        apiKey: 'sb_publishable_test_fixture',
        fetcher: async () => new Response('<html>login</html>', { status: 200 }),
      }),
    /STAGING_API_RESPONSE_INVALID/,
  );
  await assert.rejects(
    () =>
      verifyStagingApiReachability(binding, {
        apiKey: 'sb_publishable_test_fixture',
        fetcher: async () => Response.json({}),
      }),
    /STAGING_AUTH_SETTINGS_INVALID/,
  );
  await assert.rejects(
    () =>
      verifyStagingApiReachability(binding, {
        apiKey: 'sb_publishable_test_fixture',
        fetcher: async (url, options) =>
          url.endsWith('/auth/v1/settings') ? good(url, options) : Response.json({}),
      }),
    /STAGING_DATA_API_NOT_READY/,
  );
});

test('fails closed on a network exception without echoing the URL or key', async () => {
  await assert.rejects(
    () =>
      verifyStagingApiReachability(binding, {
        apiKey: 'sb_publishable_test_fixture',
        fetcher: async () => {
          throw new Error('sensitive network context');
        },
      }),
    (e) => e.message === 'STAGING_API_UNREACHABLE',
  );
});
