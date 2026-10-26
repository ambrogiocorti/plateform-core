import { pathToFileURL } from 'node:url';
import { validateStagingTarget } from './verify-staging-edge-denial.mjs';

/** Browser preflight checks for the exact Preview origin, without any mutations. */
export const browserFacingEndpoints = Object.freeze([
  'public-telemetry',
  'reservation',
  'customer-session',
  'staff-admin',
  'step-up',
  'offline-authorization',
  'reservation-deposit',
]);

export async function verifyStagingEdgeCors({
  origin,
  ref,
  productionRef,
  publishableKey,
  previewOrigin,
  fetcher = fetch,
}) {
  validateStagingTarget({ origin, ref, productionRef, publishableKey });
  const url = new URL(previewOrigin);
  if (
    url.protocol !== 'https:' ||
    url.origin !== previewOrigin ||
    url.username ||
    url.password ||
    !url.hostname.endsWith('.vercel.app')
  )
    throw new Error('PREVIEW_REQUIRES_EXACT_HTTPS_VERCEL_ORIGIN');

  const results = [];
  for (const slug of browserFacingEndpoints) {
    try {
      const response = await fetcher(`${origin}/functions/v1/${slug}`, {
        method: 'OPTIONS',
        headers: {
          Origin: previewOrigin,
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers': 'apikey,authorization,content-type',
        },
        redirect: 'manual',
        signal: AbortSignal.timeout(12000),
      });
      const allowed = response.headers.get('access-control-allow-origin');
      results.push({
        function: slug,
        status: response.status,
        pass: response.status === 204 && allowed === previewOrigin,
      });
    } catch {
      results.push({ function: slug, status: 'network_error', pass: false });
    }
  }
  return { passed: results.every((entry) => entry.pass), results };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await verifyStagingEdgeCors({
    origin: process.env.PLATEFORM_STAGING_URL,
    ref: process.env.PLATEFORM_STAGING_PROJECT_REF,
    productionRef: process.env.PLATEFORM_PRODUCTION_PROJECT_REF,
    publishableKey: process.env.PLATEFORM_STAGING_PUBLISHABLE_KEY,
    previewOrigin: process.env.PLATEFORM_STAGING_PREVIEW_ORIGIN,
  });
  for (const entry of result.results)
    console.log(`${entry.pass ? 'PASS' : 'FAIL'} CORS ${entry.function}: HTTP ${entry.status}`);
  console.log(
    `STAGING_EDGE_CORS_PREFLIGHT=${result.passed ? 'PASS' : 'FAIL'} (${result.results.filter((entry) => entry.pass).length}/${result.results.length})`,
  );
  if (!result.passed) process.exitCode = 1;
}
