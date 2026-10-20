import {
  type ClaimedAction,
  ProviderError,
  type ProviderRefund,
  type RefundProvider,
  requestSchema,
  runWorker,
  validWorkerToken,
  type WorkerDeps,
} from '../reservation-deposit-no-show-worker/worker.ts';
import {
  mapSatispayRefund,
  mapStripeRefund,
  paymentIntentFromCheckout,
  stripeRefundTarget,
} from '../reservation-deposit-no-show-worker/mapping.ts';

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
const eq = (a: unknown, b: unknown, message: string) =>
  assert(JSON.stringify(a) === JSON.stringify(b), `${message}: ${JSON.stringify(a)}`);

const ACTION = '11111111-1111-4111-8111-111111111111';
const LEASE = '22222222-2222-4222-8222-222222222222';
const claim = (over: Partial<ClaimedAction> = {}) => ({
  status: 'CLAIMED',
  id: ACTION,
  lease_token: LEASE,
  attempt: 1,
  max_attempts: 12,
  venue_id: '33333333-3333-4333-8333-333333333333',
  reservation_id: '44444444-4444-4444-8444-444444444444',
  deposit_id: '55555555-5555-4555-8555-555555555555',
  provider: 'STRIPE',
  provider_payment_id: 'cs_test_abc',
  provider_refund_id: null,
  amount_cents: 5000,
  currency: 'EUR',
  provider_idempotency_key: ACTION,
  ...over,
});
const refund = (over: Partial<ProviderRefund> = {}): ProviderRefund => ({
  id: 're_1',
  state: 'COMPLETED',
  amountCents: 5000,
  currency: 'EUR',
  actionReference: ACTION,
  ...over,
});

function harness(
  claims: unknown[],
  provider: Partial<RefundProvider>,
  finishResult: { data: unknown; error: unknown } = {
    data: { duplicate_event: false },
    error: null,
  },
) {
  const calls: { finish: unknown[]; release: unknown[]; create: number; read: string[] } = {
    finish: [],
    release: [],
    create: 0,
    read: [],
  };
  const deps: WorkerDeps = {
    claim: () => Promise.resolve({ data: claims.shift() ?? { status: 'IDLE' }, error: null }),
    finish: (args) => {
      calls.finish.push(args);
      return Promise.resolve(finishResult);
    },
    releaseUnknown: (args) => {
      calls.release.push(args);
      return Promise.resolve({ data: { state: 'RECONCILIATION_REQUIRED' }, error: null });
    },
    provider: () => ({
      createRefund: (a) => {
        calls.create++;
        return provider.createRefund ? provider.createRefund(a) : Promise.reject(new Error('x'));
      },
      readRefund: (a, id) => {
        calls.read.push(id);
        return provider.readRefund ? provider.readRefund(a, id) : Promise.reject(new Error('x'));
      },
    }),
    now: () => 0,
  };
  return { deps, calls };
}

Deno.test('Idle queue (deposits unlicensed) is a clear no-op', async () => {
  const { deps, calls } = harness([], {});
  const result = await runWorker(deps, 10);
  eq(result.status, 'IDLE', 'status');
  eq(result.processed, 0, 'processed');
  assert(result.message.includes('No reservation deposit'), 'message');
  eq(calls.create + calls.finish.length + calls.release.length, 0, 'no side effects');
});

Deno.test(
  'Request body defaults and bounds match invoke_reservation_deposit_no_show_worker',
  () => {
    eq(requestSchema.parse({}).max_jobs, 10, 'default');
    eq(requestSchema.parse({ max_jobs: 25 }).max_jobs, 25, 'max');
    assert(!requestSchema.safeParse({ max_jobs: 26 }).success, '26 accepted');
    assert(!requestSchema.safeParse({ max_jobs: 1, extra: true }).success, 'extra accepted');
  },
);

Deno.test('Completed provider refund finishes with verified amount and stable event', async () => {
  const { deps, calls } = harness([claim()], { createRefund: () => Promise.resolve(refund()) });
  const result = await runWorker(deps, 10);
  eq(result.completed, 1, 'completed');
  eq(
    calls.finish[0],
    {
      p_action: ACTION,
      p_lease: LEASE,
      p_provider_refund_id: 're_1',
      p_state: 'COMPLETED',
      p_amount: 5000,
      p_currency: 'EUR',
      p_event: 'no-show:read:re_1:COMPLETED',
      p_error_code: null,
    },
    'finish args',
  );
});

Deno.test('Pending refund is WAITING with a per-attempt event; known id is polled', async () => {
  const { deps, calls } = harness([claim({ provider_refund_id: 're_1', attempt: 3 })], {
    readRefund: () => Promise.resolve(refund({ state: 'WAITING' })),
  });
  const result = await runWorker(deps, 10);
  eq(calls.create, 0, 'no second create');
  eq(calls.read, ['re_1'], 'polled');
  eq(result.waiting, 1, 'waiting');
  eq((calls.finish[0] as { p_event: string }).p_event, 'no-show:read:re_1:WAITING:3', 'event');
});

Deno.test('Unknown create outcome goes to reconciliation, never retried blindly', async () => {
  const { deps, calls } = harness([claim()], {
    createRefund: () => Promise.reject(new ProviderError('PROVIDER_UNAVAILABLE')),
  });
  const result = await runWorker(deps, 10);
  eq(result.reconciliation_required, 1, 'reconciliation');
  eq(calls.finish.length, 0, 'no finish');
  eq(
    calls.release[0],
    { p_action: ACTION, p_lease: LEASE, p_error_code: 'REMOTE_OUTCOME_UNKNOWN' },
    'release',
  );
});

Deno.test('Transient poll failure keeps the lease for the claim RPC to re-queue', async () => {
  const { deps, calls } = harness([claim({ provider_refund_id: 're_1' })], {
    readRefund: () => Promise.reject(new ProviderError('PROVIDER_UNAVAILABLE')),
  });
  const result = await runWorker(deps, 10);
  eq(result.retry_later, 1, 'retry later');
  eq(calls.release.length + calls.finish.length, 0, 'no DB transition');
});

Deno.test('Mismatched provider answer is never sent to finish', async () => {
  for (const bad of [
    refund({ amountCents: 4999 }),
    refund({ currency: 'USD' }),
    refund({ actionReference: null }),
  ]) {
    const { deps, calls } = harness([claim()], { createRefund: () => Promise.resolve(bad) });
    await runWorker(deps, 1);
    eq(calls.finish.length, 0, 'finish called');
    eq(
      (calls.release[0] as { p_error_code: string }).p_error_code,
      'PROVIDER_VERIFICATION_FAILED',
      'code',
    );
  }
  const { deps, calls } = harness([claim({ provider_refund_id: 're_1' })], {
    readRefund: () => Promise.resolve(refund({ id: 're_2' })),
  });
  await runWorker(deps, 1);
  eq(calls.finish.length, 0, 'refund id swap accepted');
});

Deno.test(
  'Provider failure finishes FAILED with code; DB rejection releases the lease',
  async () => {
    const failed = harness([claim()], {
      createRefund: () => Promise.resolve(refund({ state: 'FAILED', failureCode: 'STRIPE_X' })),
    });
    eq((await runWorker(failed.deps, 1)).failed, 1, 'failed');
    eq((failed.calls.finish[0] as { p_error_code: string }).p_error_code, 'STRIPE_X', 'code');
    const rejected = harness(
      [claim()],
      { createRefund: () => Promise.resolve(refund()) },
      {
        data: null,
        error: { message: 'DEPOSIT_REFUND_CONFLICT' },
      },
    );
    const result = await runWorker(rejected.deps, 1);
    eq(result.results[0]?.code, 'DEPOSIT_REFUND_CONFLICT', 'surfaced');
    eq(rejected.calls.release.length, 1, 'released');
  },
);

Deno.test('Loop honours max_jobs, malformed claims and claim errors', async () => {
  const many = harness([claim(), claim(), claim()], {
    createRefund: () => Promise.resolve(refund()),
  });
  eq((await runWorker(many.deps, 2)).processed, 2, 'max_jobs');
  const malformed = harness([{ ...claim(), amount_cents: 'x' }], {});
  const result = await runWorker(malformed.deps, 5);
  eq(malformed.calls.release.length, 1, 'malformed released');
  eq(result.results[0]?.code, 'INVALID_CLAIM', 'code');
  const broken = harness([], {});
  broken.deps.claim = () => Promise.resolve({ data: null, error: { message: 'boom' } });
  let threw = false;
  try {
    await runWorker(broken.deps, 1);
  } catch (error) {
    threw = (error as Error).message === 'REQUEST_FAILED';
  }
  assert(threw, 'claim error not surfaced');
});

Deno.test('Worker token is required, constant-time compared and fails closed', async () => {
  const token = 'a'.repeat(64);
  assert(await validWorkerToken(token, token), 'valid rejected');
  assert(!(await validWorkerToken('b'.repeat(64), token)), 'wrong accepted');
  assert(!(await validWorkerToken(null, token)), 'missing accepted');
  assert(!(await validWorkerToken(token, undefined)), 'unset server secret accepted');
  assert(!(await validWorkerToken('short', 'short')), 'weak server secret accepted');
});

Deno.test('Provider payload mapping', () => {
  const stripe = mapStripeRefund({
    id: 're_9',
    object: 'refund',
    amount: 5000,
    currency: 'eur',
    status: 'pending',
    metadata: { no_show_action_id: ACTION },
  });
  eq([stripe.state, stripe.currency, stripe.actionReference], ['WAITING', 'EUR', ACTION], 'stripe');
  const failed = mapStripeRefund({
    id: 're_9',
    amount: 5000,
    currency: 'eur',
    status: 'failed',
    failure_reason: 'expired_or_canceled_card',
    metadata: {},
  });
  eq([failed.state, failed.failureCode], ['FAILED', 'STRIPE_REFUND_EXPIRED_OR_CANCELED_CARD'], 'f');
  eq(stripeRefundTarget('cs_test_a1').kind, 'checkout_session', 'cs');
  eq(stripeRefundTarget('pi_123').kind, 'payment_intent', 'pi');
  let rejected = false;
  try {
    stripeRefundTarget('https://evil/');
  } catch {
    rejected = true;
  }
  assert(rejected, 'bad reference accepted');
  eq(
    paymentIntentFromCheckout(
      {
        id: 'cs_1',
        object: 'checkout.session',
        payment_status: 'paid',
        payment_intent: 'pi_1',
        livemode: false,
      },
      false,
    ),
    'pi_1',
    'pi from session',
  );
  let modeMismatch = false;
  try {
    paymentIntentFromCheckout(
      {
        id: 'cs_1',
        object: 'checkout.session',
        payment_status: 'paid',
        payment_intent: 'pi_1',
        livemode: true,
      },
      false,
    );
  } catch {
    modeMismatch = true;
  }
  assert(modeMismatch, 'livemode mismatch accepted');
  const satispay = mapSatispayRefund(
    { id: 'sp_1', amount_unit: 5000, currency: 'EUR', status: 'ACCEPTED', external_code: ACTION },
    ACTION,
  );
  eq([satispay.state, satispay.actionReference], ['COMPLETED', ACTION], 'satispay');
  eq(
    mapSatispayRefund({ id: 'sp_1', amount_unit: 5000, currency: 'EUR', status: 'PENDING' }, ACTION)
      .actionReference,
    null,
    'unechoed reference',
  );
});
