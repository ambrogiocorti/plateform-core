import { pathToFileURL } from 'node:url';
import { verifyStagingProjectBinding } from './verify-staging-project-binding.mjs';

function blocked(code) {
  throw new Error(code);
}

export async function verifyStagingApiReachability(
  binding,
  { apiKey, fetcher = fetch, timeoutMs = 12_000 } = {},
) {
  if (binding?.status !== 'PASS' || !binding.project_ref)
    blocked('STAGING_UNVERIFIED_PROJECT_BINDING');
  if (typeof apiKey !== 'string' || !apiKey) blocked('STAGING_API_KEY_REQUIRED');

  const endpoint = `https://${binding.project_ref}.supabase.co`;
  const headers = { apikey: apiKey, Accept: 'application/json' };
  async function getJson(path) {
    let response;
    try {
      response = await fetcher(endpoint + path, {
        method: 'GET',
        headers,
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      blocked('STAGING_API_UNREACHABLE');
    }
    if (response.status !== 200) blocked('STAGING_API_NOT_READY');
    let value;
    try {
      value = await response.json();
    } catch {
      blocked('STAGING_API_RESPONSE_INVALID');
    }
    if (!value || typeof value !== 'object' || Array.isArray(value))
      blocked('STAGING_API_RESPONSE_INVALID');
    return value;
  }

  const auth = await getJson('/auth/v1/settings');
  if (typeof auth.disable_signup !== 'boolean' || typeof auth.external !== 'object')
    blocked('STAGING_AUTH_SETTINGS_INVALID');

  const rest = await getJson('/rest/v1/');
  if (!rest.swagger && !rest.openapi && !rest.paths) blocked('STAGING_DATA_API_NOT_READY');

  return {
    status: 'PASS',
    project_ref: binding.project_ref,
    checks: ['AUTH_SETTINGS_REACHABLE', 'DATA_API_KEY_ACCEPTED'],
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const binding = verifyStagingProjectBinding({
      stagingOrigin: process.env.PLATEFORM_STAGING_ORIGIN,
      supabaseUrl: process.env.VITE_SUPABASE_URL,
      projectRef: process.env.STAGING_SUPABASE_PROJECT_REF,
      databaseUrl: process.env.STAGING_SUPABASE_DB_URL,
      publishableKey: process.env.VITE_SUPABASE_PUBLISHABLE_KEY,
    });
    await verifyStagingApiReachability(binding, {
      apiKey: process.env.VITE_SUPABASE_PUBLISHABLE_KEY,
    });
    console.log('STAGING_REMOTE_API_PREFLIGHT=PASSED');
  } catch (error) {
    console.error(`STAGING_REMOTE_API_PREFLIGHT=BLOCKED ${error.message}`);
    process.exitCode = 1;
  }
}
