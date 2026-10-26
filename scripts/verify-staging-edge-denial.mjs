import { pathToFileURL } from 'node:url';

/**
 * Live negative-access smoke checks against an explicitly selected Staging
 * Supabase project. No privileged credentials and no valid business IDs.
 * These probes may produce normal access-denied telemetry but cannot
 * submit a booking, issue a payment, or mutate a restaurant account.
 */
export const protectedEndpoints = Object.freeze([
  ['health-probe', {}],
  ['maintenance', {}],
  ['offline-authorization', {}],
  ['step-up', { password: 'unauthenticated-test-only', action: 'CHECK' }],
  ['payments', { payment_id: '00000000-0000-4000-8000-000000000777', refund_id: null }],
  [
    'print-authorization',
    {
      job_id: '00000000-0000-4000-8000-000000000777',
      lease_id: '00000000-0000-4000-8000-000000000777',
    },
  ],
  ['audit-archive-worker', { max_batches: 1 }],
  ['reservation-deposit-no-show-worker', {}],
  ['reservation-message-worker', {}],
  ['continuity-retention-worker', { source: 'cron', worker: 'RETENTION' }],
  ['audit-archive-verify', {}],
  ['database-unavailable-chaos-probe', {}],
]);

export function validateStagingTarget({ origin, ref, productionRef, publishableKey }) {
  if (!ref || !productionRef || ref === productionRef)
    throw new Error('STAGING_AND_PRODUCTION_REFS_MUST_BE_DISTINCT');
  if (!/^[a-z0-9]{20}$/.test(ref) || !/^[a-z0-9]{20}$/.test(productionRef))
    throw new Error('INVALID_PROJECT_REFERENCE');
  const url = new URL(origin);
  if (
    url.origin !== origin ||
    url.protocol !== 'https:' ||
    url.hostname !== `${ref}.supabase.co` ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  )
    throw new Error('STAGING_ORIGIN_MISMATCH');
  if (typeof publishableKey !== 'string' || !publishableKey.startsWith('sb_publishable_'))
    throw new Error('STAGING_PUBLISHABLE_KEY_REQUIRED');
}

export async function verifyStagingEdgeDenial({
  origin,
  ref,
  productionRef,
  publishableKey,
  fetcher = fetch,
}) {
  validateStagingTarget({ origin, ref, productionRef, publishableKey });
  const results = [];
  for (const [slug, payload] of protectedEndpoints) {
    try {
      const response = await fetcher(`${origin}/functions/v1/${slug}`, {
        method: 'POST',
        headers: { apikey: publishableKey, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(12000),
        redirect: 'manual',
      });
      results.push({ function: slug, status: response.status, pass: response.status === 401 });
    } catch {
      results.push({ function: slug, status: 'network_error', pass: false });
    }
  }
  return { passed: results.every((result) => result.pass), results };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await verifyStagingEdgeDenial({
    origin: process.env.PLATEFORM_STAGING_URL,
    ref: process.env.PLATEFORM_STAGING_PROJECT_REF,
    productionRef: process.env.PLATEFORM_PRODUCTION_PROJECT_REF,
    publishableKey: process.env.PLATEFORM_STAGING_PUBLISHABLE_KEY,
  });
  for (const entry of result.results)
    console.log(`${entry.pass ? 'PASS' : 'FAIL'} ${entry.function}: HTTP ${entry.status}`);
  console.log(
    `STAGING_EDGE_UNAUTHENTICATED_DENIAL=${result.passed ? 'PASS' : 'FAIL'} (${result.results.filter((entry) => entry.pass).length}/${result.results.length})`,
  );
  if (!result.passed) process.exitCode = 1;
}
