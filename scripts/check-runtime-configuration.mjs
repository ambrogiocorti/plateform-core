import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { loadEnv } from 'vite';
import { validateEnvironment } from '../shared/deployment.ts';

const env = loadEnv(process.env.PLATEFORM_CHECK_MODE ?? 'development', process.cwd(), '');
const config = validateEnvironment({
  environment: env.VITE_ENVIRONMENT,
  publicBaseUrl: env.VITE_PUBLIC_BASE_URL,
  staffBaseUrl: env.VITE_STAFF_BASE_URL,
  supabaseUrl: env.VITE_SUPABASE_URL,
  publishableKey: env.VITE_SUPABASE_PUBLISHABLE_KEY,
  releaseVersion: env.VITE_RELEASE_VERSION,
});
const expected = process.env.PLATEFORM_CHECK_PROJECT_REF;
if (!expected || new URL(config.supabaseUrl).hostname !== `${expected}.supabase.co`)
  throw new Error('Explicit project reference must match the configured backend.');

const checks = {};
const headers = { apikey: config.publishableKey, 'Content-Type': 'application/json' };
async function response(path, payload) {
  try {
    const result = await fetch(config.supabaseUrl + path, {
      headers,
      ...(payload ? { method: 'POST', body: JSON.stringify(payload) } : {}),
      signal: AbortSignal.timeout(15000),
    });
    return { status: result.status, data: await result.json() };
  } catch {
    return { status: 0, data: { code: 'BACKEND_UNAVAILABLE' } };
  }
}
const settings = await response('/auth/v1/settings');
checks.auth_reachable = settings.status === 200 ? 'PASSED' : 'FAILED';
checks.public_signup_disabled = settings.data.disable_signup === true ? 'PASSED' : 'BLOCKED';
checks.anonymous_auth_disabled =
  settings.data.external?.anonymous_users === false ? 'PASSED' : 'BLOCKED';
const site = await response('/rest/v1/rpc/get_public_site', {});
checks.public_projection = site.status === 200 ? 'PASSED' : 'FAILED';
for (const [name, payload] of [
  ['get_auth_requirements', {}],
  ['bootstrap_technical_user', { p_user: randomUUID(), p_name: 'Denied access check' }],
]) {
  const result = await response(`/rest/v1/rpc/${name}`, payload);
  checks[`anonymous_denied_${name}`] =
    result.status === 401 && result.data.code === '42501' ? 'PASSED' : 'FAILED';
}
const report = {
  checked_at: new Date().toISOString(),
  project_ref: expected,
  environment: config.environment,
  checks,
  status: Object.values(checks).every((value) => value === 'PASSED') ? 'PASSED' : 'BLOCKED',
  limits: [
    'Does not verify password policy, JWT expiry, redirect allowlist, MFA configuration or Edge secrets.',
    'Those settings require the project management API or an authorized dashboard configuration.',
  ],
};
await mkdir('.local/evidence', { recursive: true });
await writeFile('.local/evidence/step0-runtime.json', JSON.stringify(report, null, 2) + '\n', {
  mode: 0o600,
});
console.log(JSON.stringify(report, null, 2));
if (report.status !== 'PASSED') process.exitCode = 1;
