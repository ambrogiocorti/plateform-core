// Invoked every minute by public.invoke_reservation_message_worker(p_max_jobs) through pg_net:
// POST {max_jobs} with header x-plateform-worker-token = Vault secret plateform_message_worker_token.
// No JWT is sent, so config.toml must declare verify_jwt = false; the shared token is the only authority.
import { z } from 'npm:zod@4.6.5';
import { endpoint, rateLimit, serverClient } from '../_shared/http.ts';
import {
  claimSchema,
  deliver,
  deliveryMode,
  settlement,
  workerTokenValid,
  type Env,
} from './delivery.ts';

const env: Env = (name) => Deno.env.get(name);
const LEASE_SECONDS = 60;
// Stop claiming once this much of the lease window is gone, so every claimed job is settled in time.
const CLAIM_BUDGET_MS = 40000;
const PROVIDER_TIMEOUT_MS = 10000;

function log(level: 'info' | 'error', request: Request, fields: Record<string, unknown>) {
  // Only identifiers and codes: never destinations, message bodies, tokens or provider credentials.
  (level === 'error' ? console.error : console.log)(
    JSON.stringify({
      level,
      request_id: request.headers.get('x-request-id'),
      operation: 'reservation-message-worker',
      ...fields,
    }),
  );
}

Deno.serve(
  endpoint(
    z.object({ max_jobs: z.number().int().min(1).max(50).default(20) }).strict(),
    async (body, request) => {
      if (
        !(await workerTokenValid(
          env('MESSAGE_WORKER_TOKEN'),
          request.headers.get('x-plateform-worker-token'),
        ))
      )
        throw new Error('UNAUTHORIZED');
      const mode = deliveryMode(env);
      if (!mode) {
        // Fail closed and loudly: no job is claimed, so nothing burns an attempt while unconfigured.
        log('error', request, { error_code: 'MESSAGE_DELIVERY_MODE_NOT_CONFIGURED' });
        throw new Error('SERVICE_UNAVAILABLE');
      }
      await rateLimit('reservation-message-worker', 120, 600, request);
      const server = serverClient(request),
        started = performance.now(),
        summary = {
          mode,
          claimed: 0,
          sent: 0,
          retry_scheduled: 0,
          failed: 0,
          reconciliation_required: 0,
          settle_errors: 0,
          idle: false,
          claim_error: null as string | null,
        };
      for (let n = 0; n < body.max_jobs; n++) {
        if (performance.now() - started > CLAIM_BUDGET_MS) break;
        const { data, error } = await server.rpc('claim_message_job', {
          p_lease_seconds: LEASE_SECONDS,
        });
        if (error) {
          summary.claim_error = /^[A-Z_]{3,64}$/.test(error.message)
            ? error.message
            : 'CLAIM_FAILED';
          log('error', request, { error_code: summary.claim_error });
          break;
        }
        const parsed = claimSchema.safeParse(data);
        if (!parsed.success) {
          summary.claim_error = 'CLAIM_RESPONSE_INVALID';
          log('error', request, { error_code: summary.claim_error });
          break;
        }
        const claim = parsed.data;
        if (claim.status === 'IDLE') {
          summary.idle = true;
          break;
        }
        summary.claimed++;
        const outcome = await deliver(claim, {
          mode,
          env,
          fetch: (input, init) => fetch(input, init),
          timeoutMs: PROVIDER_TIMEOUT_MS,
        });
        const plan = settlement(claim, outcome);
        const { error: settleError } = await server.rpc(plan.rpc, plan.args);
        if (settleError) {
          // Typically MESSAGE_LEASE_CONFLICT after an expired lease: the claim RPC moves such jobs
          // to RECONCILIATION_REQUIRED, so the job is never silently resent.
          summary.settle_errors++;
          log('error', request, {
            job_id: claim.id,
            adapter: claim.adapter,
            outcome: outcome.kind,
            error_code: /^[A-Z_]{3,64}$/.test(settleError.message)
              ? settleError.message
              : 'SETTLE_FAILED',
          });
          continue;
        }
        if (plan.result === 'SENT') summary.sent++;
        else if (plan.result === 'RETRY') summary.retry_scheduled++;
        else if (plan.result === 'FAILED') summary.failed++;
        else summary.reconciliation_required++;
        log(outcome.kind === 'SENT' ? 'info' : 'error', request, {
          job_id: claim.id,
          channel: claim.channel,
          adapter: claim.adapter,
          attempt: claim.attempt,
          result: plan.result,
          ...(outcome.kind === 'SENT' ? {} : { error_code: outcome.code }),
        });
      }
      return summary;
    },
  ),
);
