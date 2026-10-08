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

const cases = [
  { name: 'anonymous_denied', status: 401, code: 'UNAUTHORIZED' },
  {
    name: 'allowed_staff_origin',
    origin: new URL(config.staffBaseUrl).origin,
    status: 401,
    code: 'UNAUTHORIZED',
    cors: true,
  },
  {
    name: 'allowed_public_origin',
    origin: new URL(config.publicBaseUrl).origin,
    status: 401,
    code: 'UNAUTHORIZED',
    cors: true,
  },
  {
    name: 'forbidden_origin',
    origin: 'https://untrusted.invalid',
    status: 403,
    code: 'ORIGIN_FORBIDDEN',
  },
  {
    name: 'allowed_preflight',
    origin: new URL(config.staffBaseUrl).origin,
    method: 'OPTIONS',
    status: 204,
    cors: true,
  },
  {
    name: 'forbidden_preflight',
    origin: 'https://untrusted.invalid',
    method: 'OPTIONS',
    status: 403,
    code: 'ORIGIN_FORBIDDEN',
  },
  { name: 'method_rejected', method: 'GET', status: 405, code: 'METHOD_NOT_ALLOWED' },
  {
    name: 'content_type_rejected',
    contentType: 'text/plain',
    status: 400,
    code: 'INVALID_PAYLOAD',
  },
  { name: 'malformed_json', body: '{', status: 400, code: 'INVALID_PAYLOAD' },
  {
    name: 'unknown_fields_rejected',
    body: '{"unexpected":true}',
    status: 400,
    code: 'INVALID_PAYLOAD',
  },
  {
    name: 'oversized_body_rejected',
    body: JSON.stringify({ value: 'x'.repeat(33000) }),
    status: 400,
    code: 'PAYLOAD_TOO_LARGE',
  },
  {
    name: 'invalid_context_regenerated',
    requestId: 'invalid',
    correlationId: 'invalid',
    status: 401,
    code: 'UNAUTHORIZED',
  },
  { name: 'forged_authentication_denied', token: 'invalid', status: 401, code: 'UNAUTHORIZED' },
];

const results = [];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
for (const test of cases) {
  const requestId = test.requestId ?? randomUUID();
  const correlationId = test.correlationId ?? randomUUID();
  const headers = new Headers({
    apikey: config.publishableKey,
    'content-type': test.contentType ?? 'application/json',
    'x-request-id': requestId,
    'x-correlation-id': correlationId,
  });
  if (test.origin) headers.set('origin', test.origin);
  if (test.token) headers.set('authorization', `Bearer ${test.token}`);
  const method = test.method ?? 'POST';
  try {
    const response = await fetch(`${config.supabaseUrl}/functions/v1/health-probe`, {
      headers,
      method,
      ...(method === 'POST' ? { body: test.body ?? '{}' } : {}),
      signal: AbortSignal.timeout(15000),
    });
    const data = response.status === 204 ? null : await response.json();
    const responseRequest = response.headers.get('x-request-id');
    const responseCorrelation = response.headers.get('x-correlation-id');
    const assertions = {
      status: response.status === test.status,
      code: test.code ? data?.code === test.code : data === null,
      request_context:
        uuid.test(responseRequest ?? '') &&
        (!uuid.test(requestId) || responseRequest === requestId),
      correlation_context:
        uuid.test(responseCorrelation ?? '') &&
        (!uuid.test(correlationId) || responseCorrelation === correlationId),
      body_context: data === null || data?.request_id === responseRequest,
      minimal_error:
        data === null ||
        Object.keys(data).every((key) => ['code', 'human_message', 'request_id'].includes(key)),
      no_store: response.headers.get('cache-control') === 'no-store',
      no_sniff: response.headers.get('x-content-type-options') === 'nosniff',
      cors: test.cors
        ? response.headers.get('access-control-allow-origin') === test.origin &&
          response.headers.get('access-control-expose-headers')?.includes('X-Correlation-Id') ===
            true
        : response.headers.get('access-control-allow-origin') === null,
    };
    results.push({
      name: test.name,
      status: Object.values(assertions).every(Boolean) ? 'PASSED' : 'FAILED',
      http_status: response.status,
      code: data?.code ?? null,
      request_id: responseRequest,
      correlation_id: responseCorrelation,
      assertions,
    });
  } catch {
    results.push({ name: test.name, status: 'FAILED', code: 'BACKEND_UNAVAILABLE' });
  }
}
const report = {
  checked_at: new Date().toISOString(),
  project_ref: expected,
  environment: config.environment,
  endpoint: 'health-probe',
  status: results.every((result) => result.status === 'PASSED') ? 'PASSED' : 'FAILED',
  results,
  limits: ['Does not certify privileged health probes or authenticated domain workflows.'],
};
await mkdir('.local/evidence', { recursive: true });
await writeFile('.local/evidence/step0-edge-http.json', JSON.stringify(report, null, 2) + '\n', {
  mode: 0o600,
});
console.log(JSON.stringify(report, null, 2));
if (report.status !== 'PASSED') process.exitCode = 1;
