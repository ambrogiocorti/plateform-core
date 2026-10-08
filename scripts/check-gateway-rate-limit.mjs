import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { loadEnv } from 'vite';
import { validateEnvironment } from '../shared/deployment.ts';

// Deploy the prepared development-only entrypoint through the authorized connector,
// run this check, then restore the normal health-probe entrypoint immediately.
// The temporary capability expires after ten minutes and cannot run in production.
const env = loadEnv('development', process.cwd(), '');
const config = validateEnvironment({
  environment: env.VITE_ENVIRONMENT,
  publicBaseUrl: env.VITE_PUBLIC_BASE_URL,
  staffBaseUrl: env.VITE_STAFF_BASE_URL,
  supabaseUrl: env.VITE_SUPABASE_URL,
  publishableKey: env.VITE_SUPABASE_PUBLISHABLE_KEY,
  releaseVersion: env.VITE_RELEASE_VERSION,
});
const expected = process.env.PLATEFORM_CHECK_PROJECT_REF;
if (
  config.environment !== 'development' ||
  !expected ||
  new URL(config.supabaseUrl).hostname !== `${expected}.supabase.co`
)
  throw new Error('Only an explicitly selected development project is supported.');

await mkdir('.local/evidence', { recursive: true });
await mkdir('.local/probes', { recursive: true });
if (process.argv[2] === 'prepare') {
  const token = randomBytes(32).toString('hex');
  const tokenDigest = createHash('sha256').update(`Bearer ${token}`).digest('hex');
  const run = randomUUID();
  const expiresAt = Date.now() + 600000;
  const source = `import { z } from 'npm:zod@4.6.5';
import { endpoint, rateKey, rateLimit } from '../_shared/http.ts';
Deno.serve(endpoint(z.object({mode:z.enum(['identity','rate'])}).strict(), async (body, request) => {
  if (Deno.env.get('ENVIRONMENT') !== 'development' || Date.now() > ${expiresAt}) throw new Error('FORBIDDEN');
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(request.headers.get('authorization') ?? ''))), value => value.toString(16).padStart(2,'0')).join('');
  if (digest !== '${tokenDigest}') throw new Error('UNAUTHORIZED');
  const clientDigest = await rateKey(request);
  if (body.mode === 'rate') await rateLimit('foundation-http:${run}:' + clientDigest, 2, 60, request);
  return {client_digest:clientDigest};
}));
`;
  const files = [
    { name: 'supabase/functions/health-probe/index.ts', content: source },
    ...(await Promise.all(
      [
        'supabase/functions/_shared/http.ts',
        'shared/request-context.ts',
        'supabase/functions/deno.json',
      ].map(async (name) => ({ name, content: await readFile(name, 'utf8') })),
    )),
  ];
  await writeFile(
    '.local/probes/gateway-deployment.json',
    JSON.stringify({
      project_id: expected,
      name: 'health-probe',
      entrypoint_path: files[0].name,
      verify_jwt: false,
      files,
    }),
    { mode: 0o600 },
  );
  await writeFile(
    '.local/probes/gateway-capability.json',
    JSON.stringify({ token, run, expiresAt }),
    { mode: 0o600 },
  );
  console.log(
    JSON.stringify({
      prepared: true,
      project_ref: expected,
      run,
      expires_at: new Date(expiresAt).toISOString(),
    }),
  );
} else {
  const capability = JSON.parse(await readFile('.local/probes/gateway-capability.json', 'utf8'));
  if (Date.now() > capability.expiresAt)
    throw new Error('Temporary capability expired; prepare a new check.');
  const results = [];
  async function invoke(mode, forwarded = {}, token = capability.token) {
    const requestId = randomUUID(),
      correlationId = randomUUID();
    const response = await fetch(`${config.supabaseUrl}/functions/v1/health-probe`, {
      method: 'POST',
      body: JSON.stringify({ mode }),
      headers: {
        apikey: config.publishableKey,
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'x-request-id': requestId,
        'x-correlation-id': correlationId,
        ...forwarded,
      },
      signal: AbortSignal.timeout(15000),
    });
    const text = await response.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = { code: 'NON_JSON_GATEWAY_RESPONSE' };
    }
    return { response, body, requestId, correlationId };
  }
  const denied = await invoke('identity', {}, 'invalid');
  results.push({
    name: 'temporary_capability_rejects_invalid_token',
    status:
      denied.response.status === 401 && denied.body.code === 'UNAUTHORIZED' ? 'PASSED' : 'FAILED',
  });
  const baseline = await invoke('identity');
  const digest = baseline.body.client_digest;
  results.push({
    name: 'gateway_provides_digestible_address',
    status:
      baseline.response.status === 200 && /^[a-f0-9]{64}$/.test(digest ?? '') ? 'PASSED' : 'FAILED',
  });
  for (const [name, headers] of [
    ['forwarded_single', { 'x-forwarded-for': '203.0.113.91' }],
    ['forwarded_other', { 'x-forwarded-for': '198.51.100.92' }],
    ['forwarded_chain', { 'x-forwarded-for': '203.0.113.91, 198.51.100.92' }],
    [
      'alternate_headers',
      {
        'cf-connecting-ip': '203.0.113.91',
        'x-real-ip': '198.51.100.92',
        forwarded: 'for=203.0.113.91',
      },
    ],
  ]) {
    const actual = await invoke('identity', headers);
    results.push({
      name: `client_cannot_spoof_${name}`,
      status:
        (actual.response.status === 200 && actual.body.client_digest === digest) ||
        (name === 'alternate_headers' &&
          [400, 401, 403].includes(actual.response.status) &&
          !actual.body.client_digest)
          ? 'PASSED'
          : 'FAILED',
      http_status: actual.response.status,
    });
  }
  for (let attempt = 1; attempt <= 4; attempt++) {
    const actual = await invoke(
      'rate',
      attempt === 4 ? { 'x-forwarded-for': '198.51.100.99' } : {},
    );
    const allowed = attempt <= 2;
    results.push({
      name: `http_rate_limit_attempt_${attempt}`,
      status:
        (allowed
          ? actual.response.status === 200
          : actual.response.status === 429 && actual.body.code === 'RATE_LIMITED') &&
        actual.response.headers.get('x-request-id') === actual.requestId &&
        actual.response.headers.get('x-correlation-id') === actual.correlationId
          ? 'PASSED'
          : 'FAILED',
      http_status: actual.response.status,
      request_id: actual.requestId,
      correlation_id: actual.correlationId,
    });
  }
  const report = {
    checked_at: new Date().toISOString(),
    project_ref: expected,
    environment: 'development',
    run: capability.run,
    status: results.every((result) => result.status === 'PASSED') ? 'PASSED' : 'FAILED',
    results,
    limits: [
      'Tests the current hosted gateway and this client network path; re-run after gateway changes.',
      'Raw addresses, HMAC digests and the temporary capability are excluded from this report.',
    ],
  };
  await writeFile(
    '.local/evidence/step0-gateway-rate-limit.json',
    JSON.stringify(report, null, 2) + '\n',
    { mode: 0o600 },
  );
  console.log(JSON.stringify(report, null, 2));
  if (report.status !== 'PASSED') process.exitCode = 1;
}
