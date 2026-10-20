// Pure worker logic for no-show deposit refunds. No network, no Deno.serve: every side effect is
// injected so the state machine of 20261007121404 / 20261007121613 can be unit tested.
//
// DB contract (service_role only):
//   claim_reservation_deposit_no_show_action(p_lease_seconds) -> {status:'IDLE'} | {status:'CLAIMED',...}
//   finish_reservation_deposit_no_show_action(p_action,p_lease,p_provider_refund_id,p_state,
//     p_amount,p_currency,p_event,p_error_code) with p_state in WAITING|COMPLETED|FAILED
//   release_reservation_deposit_no_show_action_unknown(p_action,p_lease,p_error_code)
//     -> RECONCILIATION_REQUIRED (+ admin notification)
// Only a verified provider read may move a deposit; any doubt goes to reconciliation.
import { z } from 'npm:zod@4.6.5';

export const LEASE_SECONDS = 90;
/** pg_net gives up after 10 s; do not start new jobs after this budget. */
export const CLAIM_BUDGET_MS = 8000;

export const requestSchema = z
  .object({ max_jobs: z.number().int().min(1).max(25).default(10) })
  .strict();

export const claimSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('IDLE') }).passthrough(),
  z
    .object({
      status: z.literal('CLAIMED'),
      id: z.uuid(),
      lease_token: z.uuid(),
      attempt: z.number().int().positive(),
      max_attempts: z.number().int().positive(),
      venue_id: z.uuid(),
      reservation_id: z.uuid(),
      deposit_id: z.uuid(),
      provider: z.enum(['STRIPE', 'SATISPAY']).nullable(),
      provider_payment_id: z.string().min(1).max(240).nullable(),
      provider_refund_id: z.string().min(1).max(240).nullable(),
      amount_cents: z.number().int(),
      currency: z.literal('EUR'),
      provider_idempotency_key: z.uuid(),
    })
    .passthrough(),
]);
export type ClaimedAction = Extract<z.infer<typeof claimSchema>, { status: 'CLAIMED' }>;

export type RefundState = 'WAITING' | 'COMPLETED' | 'FAILED';
export interface ProviderRefund {
  id: string;
  state: RefundState;
  amountCents: number;
  currency: string;
  /** Our action id echoed back by the provider (metadata / external_code). */
  actionReference: string | null;
  failureCode?: string;
}

/** Thrown by provider adapters. `phase` says whether a refund may exist remotely. */
export class ProviderError extends Error {
  constructor(
    code:
      | 'PROVIDER_CONFIGURATION_REQUIRED'
      | 'PROVIDER_REQUEST_REJECTED'
      | 'PROVIDER_UNAVAILABLE'
      | 'PROVIDER_VERIFICATION_FAILED'
      | 'INVALID_PROVIDER_REFERENCE',
  ) {
    super(code);
  }
}

export interface RefundProvider {
  /** Create (idempotently, keyed by idempotencyKey) a refund of the original payment. */
  createRefund(action: ClaimedAction): Promise<ProviderRefund>;
  /** Authoritative read of an already-known refund. */
  readRefund(action: ClaimedAction, refundId: string): Promise<ProviderRefund>;
}

export interface WorkerDeps {
  claim(leaseSeconds: number): PromiseLike<{ data: unknown; error: unknown }>;
  finish(args: {
    p_action: string;
    p_lease: string;
    p_provider_refund_id: string | null;
    p_state: RefundState;
    p_amount: number;
    p_currency: 'EUR';
    p_event: string;
    p_error_code: string | null;
  }): PromiseLike<{ data: unknown; error: unknown }>;
  releaseUnknown(args: {
    p_action: string;
    p_lease: string;
    p_error_code: string;
  }): PromiseLike<{ data: unknown; error: unknown }>;
  provider(name: 'STRIPE' | 'SATISPAY'): RefundProvider;
  now(): number;
}

export type Outcome =
  | 'COMPLETED'
  | 'WAITING'
  | 'FAILED'
  | 'RECONCILIATION_REQUIRED'
  | 'RETRY_LATER'
  | 'DUPLICATE_EVENT'
  | 'DB_REJECTED';

export interface JobResult {
  id: string;
  provider: string | null;
  outcome: Outcome;
  code: string | null;
}

export interface WorkerSummary {
  status: 'IDLE' | 'PROCESSED';
  message: string;
  max_jobs: number;
  processed: number;
  completed: number;
  waiting: number;
  failed: number;
  reconciliation_required: number;
  retry_later: number;
  budget_exhausted: boolean;
  results: JobResult[];
}

/** Event ids are unique per (provider,event_id). WAITING is per attempt so a re-poll that still
 *  reads "pending" is recorded instead of being swallowed as a duplicate with the lease held. */
export function providerEventId(refund: ProviderRefund, attempt: number): string {
  const base = `no-show:read:${refund.id}:${refund.state}`;
  return (refund.state === 'WAITING' ? `${base}:${attempt}` : base).slice(0, 240);
}

/** Checks the provider answer against the claimed action before the DB ever sees it. */
export function verifyRefund(action: ClaimedAction, refund: ProviderRefund): boolean {
  return (
    refund.id.length >= 1 &&
    refund.id.length <= 240 &&
    refund.amountCents === action.amount_cents &&
    refund.currency.toUpperCase() === 'EUR' &&
    refund.actionReference === action.provider_idempotency_key &&
    (action.provider_refund_id === null || action.provider_refund_id === refund.id)
  );
}

export async function constantTimeEqual(provided: string, expected: string): Promise<boolean> {
  const encode = (value: string) => new TextEncoder().encode(value);
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', encode(provided)),
    crypto.subtle.digest('SHA-256', encode(expected)),
  ]);
  const x = new Uint8Array(a),
    y = new Uint8Array(b);
  let difference = 0;
  for (let i = 0; i < x.length; i++) difference |= x[i]! ^ y[i]!;
  return difference === 0;
}

/** The DB stores a ≥32 character Vault token (default 64 hex) and sends it as
 *  x-plateform-worker-token. Fails closed when the server copy is missing or weak. */
export async function validWorkerToken(
  provided: string | null,
  expected: string | undefined,
): Promise<boolean> {
  if (!expected || expected.length < 32 || expected.length > 1024 || /\s/.test(expected))
    return false;
  if (!provided || provided.length > 1024) return false;
  return await constantTimeEqual(provided, expected);
}

const errorCode = (error: unknown): string =>
  typeof error === 'object' && error !== null && 'message' in error
    ? String((error as { message: unknown }).message).slice(0, 160)
    : 'UNKNOWN';

async function reconcile(
  deps: WorkerDeps,
  action: { id: string; lease_token: string },
  code: string,
  provider: string | null,
): Promise<JobResult> {
  const { error } = await deps.releaseUnknown({
    p_action: action.id,
    p_lease: action.lease_token,
    p_error_code: code,
  });
  return {
    id: action.id,
    provider,
    outcome: error ? 'DB_REJECTED' : 'RECONCILIATION_REQUIRED',
    code: error ? errorCode(error) : code,
  };
}

export async function processAction(deps: WorkerDeps, action: ClaimedAction): Promise<JobResult> {
  if (!action.provider || !action.provider_payment_id || action.amount_cents <= 0)
    return await reconcile(deps, action, 'INVALID_PROVIDER_COMMAND', action.provider);
  const provider = deps.provider(action.provider);
  const polling = action.provider_refund_id !== null;
  let refund: ProviderRefund;
  try {
    refund = polling
      ? await provider.readRefund(action, action.provider_refund_id!)
      : await provider.createRefund(action);
  } catch (error) {
    const code = error instanceof ProviderError ? error.message : 'REMOTE_OUTCOME_UNKNOWN';
    // A known refund id with a transient read failure: keep the lease; on expiry the claim RPC
    // puts it back to WAITING and the next run polls again (bounded by max_attempts).
    if (polling && code === 'PROVIDER_UNAVAILABLE')
      return { id: action.id, provider: action.provider, outcome: 'RETRY_LATER', code };
    // A create that may or may not have reached the provider is never retried blindly.
    return await reconcile(
      deps,
      action,
      code === 'PROVIDER_UNAVAILABLE' ? 'REMOTE_OUTCOME_UNKNOWN' : code,
      action.provider,
    );
  }
  if (!verifyRefund(action, refund))
    return await reconcile(deps, action, 'PROVIDER_VERIFICATION_FAILED', action.provider);
  const { data, error } = await deps.finish({
    p_action: action.id,
    p_lease: action.lease_token,
    p_provider_refund_id: refund.id,
    p_state: refund.state,
    p_amount: refund.amountCents,
    p_currency: 'EUR',
    p_event: providerEventId(refund, action.attempt),
    p_error_code:
      refund.state === 'FAILED'
        ? (refund.failureCode ?? 'PROVIDER_REFUND_FAILED').slice(0, 160)
        : null,
  });
  if (error) {
    // The finish transaction rolled back; the action is still IN_FLIGHT under our lease.
    const released = await reconcile(deps, action, 'PROVIDER_RESULT_REJECTED', action.provider);
    return { ...released, code: `${errorCode(error)}` };
  }
  const duplicate =
    typeof data === 'object' &&
    data !== null &&
    (data as { duplicate_event?: unknown }).duplicate_event === true;
  return {
    id: action.id,
    provider: action.provider,
    outcome: duplicate ? 'DUPLICATE_EVENT' : refund.state,
    code: refund.state === 'FAILED' ? (refund.failureCode ?? 'PROVIDER_REFUND_FAILED') : null,
  };
}

export async function runWorker(deps: WorkerDeps, maxJobs: number): Promise<WorkerSummary> {
  const started = deps.now();
  const results: JobResult[] = [];
  let budgetExhausted = false;
  for (let n = 0; n < maxJobs; n++) {
    if (deps.now() - started > CLAIM_BUDGET_MS) {
      budgetExhausted = true;
      break;
    }
    const { data, error } = await deps.claim(LEASE_SECONDS);
    if (error) {
      if (results.length === 0) throw new Error('REQUEST_FAILED');
      break;
    }
    const parsed = claimSchema.safeParse(data);
    if (!parsed.success) {
      // Malformed claim: release it to reconciliation when we can identify the lease.
      const lease = z.object({ id: z.uuid(), lease_token: z.uuid() }).safeParse(data);
      if (lease.success) results.push(await reconcile(deps, lease.data, 'INVALID_CLAIM', null));
      else if (results.length === 0) throw new Error('REQUEST_FAILED');
      break;
    }
    if (parsed.data.status === 'IDLE') break;
    results.push(await processAction(deps, parsed.data as ClaimedAction));
  }
  const count = (outcome: Outcome) => results.filter((r) => r.outcome === outcome).length;
  return {
    status: results.length === 0 ? 'IDLE' : 'PROCESSED',
    message:
      results.length === 0
        ? 'No reservation deposit no-show refunds are due (online booking deposits may be unlicensed in this edition).'
        : `Processed ${results.length} reservation deposit no-show refund action(s).`,
    max_jobs: maxJobs,
    processed: results.length,
    completed: count('COMPLETED'),
    waiting: count('WAITING'),
    failed: count('FAILED'),
    reconciliation_required: count('RECONCILIATION_REQUIRED'),
    retry_later: count('RETRY_LATER'),
    budget_exhausted: budgetExhausted,
    results,
  };
}
