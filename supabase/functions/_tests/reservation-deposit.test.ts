// Unit tests for the large-group booking deposit checkout (no network, no database).
import {
  type DepositGateway,
  type DepositRecord,
  depositReturnUrl,
  depositStatus,
  guestOutcome,
  type ProviderPayment,
  reconcileDeposit,
  requestSchema,
  startCheckout,
  verifyPayment,
} from '../_shared/deposits.ts';
import {
  mapSatispayDeposit,
  mapStripeDepositSession,
  stripeDepositEvent,
  stripeSessionExpiry,
} from '../_shared/deposit-providers.ts';
import { satispayCallbackToken, satispayDepositCallbackToken } from '../_shared/providers.ts';

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
function equal(actual: unknown, expected: unknown, message: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error(`${message}: ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`);
}
async function rejects(run: () => Promise<unknown>, code: string, message: string) {
  try {
    await run();
  } catch (error) {
    equal((error as Error).message, code, message);
    return;
  }
  throw new Error(`${message}: did not throw`);
}

const depositId = '11111111-1111-4111-8111-111111111111';
const token = 'a'.repeat(64);
const base = (overrides: Partial<DepositRecord> = {}): DepositRecord => ({
  deposit_id: depositId,
  reservation_id: '22222222-2222-4222-8222-222222222222',
  venue_id: '33333333-3333-4333-8333-333333333333',
  venue_slug: 'centro',
  deposit_status: 'PENDING',
  reservation_status: 'PENDING_DEPOSIT',
  provider: 'STRIPE',
  provider_reference: null,
  amount_cents: 2000,
  currency: 'EUR',
  expires_at: '2026-10-21T20:45:00Z',
  providers: ['STRIPE'],
  ...overrides,
});
const payment = (overrides: Partial<ProviderPayment> = {}): ProviderPayment => ({
  reference: 'cs_test_1',
  state: 'WAITING',
  amountCents: 2000,
  currency: 'EUR',
  depositReference: depositId,
  checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_test_1',
  ...overrides,
});

/** Records every RPC; answers with the scripted values (or errors). */
function fakeDeps(
  answers: Record<string, Array<{ data?: unknown; error?: { message: string } }>>,
  gateway: Partial<DepositGateway> = {},
) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const providerCalls: string[] = [];
  return {
    calls,
    providerCalls,
    deps: {
      rpc: (name: string, args: Record<string, unknown>) => {
        calls.push({ name, args });
        const next = answers[name]?.shift() ?? { data: null };
        return Promise.resolve({ data: next.data ?? null, error: next.error ?? null });
      },
      gateway: {
        create: (provider, deposit) => {
          providerCalls.push(`create:${provider}`);
          return gateway.create ? gateway.create(provider, deposit) : Promise.resolve(payment());
        },
        read: (provider, deposit, reference) => {
          providerCalls.push(`read:${provider}:${reference}`);
          return gateway.read
            ? gateway.read(provider, deposit, reference)
            : Promise.resolve(payment());
        },
      } as DepositGateway,
    },
  };
}
const start = {
  action: 'start' as const,
  deposit_id: depositId,
  access_token: token,
  provider: 'STRIPE' as const,
  idempotency_key: '44444444-4444-4444-8444-444444444444',
};

Deno.test('request schema accepts the browser contract and rejects weak tokens', () => {
  equal(
    requestSchema.parse({ ...start, action: undefined }).action,
    'start',
    'start is the default action',
  );
  assert(
    !requestSchema.safeParse({ ...start, access_token: 'short' }).success,
    'weak token accepted',
  );
  assert(
    !requestSchema.safeParse({ ...start, provider: 'PAYPAL' }).success,
    'unknown provider accepted',
  );
  assert(
    requestSchema.safeParse({ action: 'status', deposit_id: depositId, access_token: token })
      .success,
    'status rejected',
  );
});

Deno.test('the licence gate runs before any provider call', async () => {
  const { deps, providerCalls } = fakeDeps({
    begin_reservation_deposit: [{ error: { message: 'BOOKING_DEPOSITS_DISABLED' } }],
  });
  await rejects(() => startCheckout(deps, start), 'BOOKING_DEPOSITS_DISABLED', 'gate code');
  equal(providerCalls, [], 'no provider contacted');
  const denied = fakeDeps({
    begin_reservation_deposit: [{ error: { message: 'DEPOSIT_ACCESS_DENIED' } }],
  });
  await rejects(() => startCheckout(denied.deps, start), 'FORBIDDEN', 'token denial');
  const internal = fakeDeps({
    begin_reservation_deposit: [{ error: { message: 'some internal detail' } }],
  });
  await rejects(() => startCheckout(internal.deps, start), 'REQUEST_FAILED', 'no leak');
});

Deno.test('a new checkout binds the provider reference and returns the verified URL', async () => {
  const { deps, calls, providerCalls } = fakeDeps({
    begin_reservation_deposit: [{ data: {} }],
    get_reservation_deposit_status: [{ data: base() }],
    bind_reservation_deposit_provider_reference: [{ data: {} }],
  });
  const result = await startCheckout(deps, start);
  equal(
    result,
    {
      deposit_id: depositId,
      provider: 'STRIPE',
      state: 'WAITING',
      checkout_url: 'https://checkout.stripe.com/c/pay/cs_test_1',
    },
    'checkout',
  );
  equal(providerCalls, ['create:STRIPE'], 'one create');
  equal(
    calls.map((call) => call.name),
    [
      'begin_reservation_deposit',
      'get_reservation_deposit_status',
      'bind_reservation_deposit_provider_reference',
    ],
    'rpc order',
  );
  assert(
    !calls.some((call) => call.name === 'apply_reservation_deposit_callback'),
    'a WAITING checkout confirmed nothing',
  );
});

Deno.test('a resumed checkout re-reads the bound session instead of creating another', async () => {
  const { deps, providerCalls } = fakeDeps({
    begin_reservation_deposit: [{ data: {} }],
    get_reservation_deposit_status: [{ data: base({ provider_reference: 'cs_test_1' }) }],
  });
  await startCheckout(deps, start);
  equal(providerCalls, ['read:STRIPE:cs_test_1'], 'read, no create');
});

Deno.test('a provider answer for another amount or deposit is refused before the DB', async () => {
  for (const wrong of [
    payment({ amountCents: 1 }),
    payment({ depositReference: null }),
    payment({ currency: 'USD' }),
  ]) {
    const { deps, calls } = fakeDeps(
      {
        begin_reservation_deposit: [{ data: {} }],
        get_reservation_deposit_status: [{ data: base() }],
      },
      { create: () => Promise.resolve(wrong) },
    );
    await rejects(() => startCheckout(deps, start), 'PROVIDER_VERIFICATION_FAILED', 'mismatch');
    assert(
      !calls.some((call) => call.name === 'bind_reservation_deposit_provider_reference'),
      'mismatched reference bound',
    );
  }
  assert(
    !verifyPayment(base({ provider_reference: 'cs_other' }), payment()),
    'reference swap accepted',
  );
});

Deno.test('a paid read confirms through the deposit callback with a read event id', async () => {
  const { deps, calls } = fakeDeps(
    {
      begin_reservation_deposit: [{ data: {} }],
      get_reservation_deposit_status: [{ data: base({ provider_reference: 'cs_test_1' }) }],
      apply_reservation_deposit_callback: [{ data: {} }],
    },
    { read: () => Promise.resolve(payment({ state: 'COMPLETED', checkoutUrl: null })) },
  );
  const result = await startCheckout(deps, start);
  equal(result.state, 'COMPLETED', 'state');
  equal(result.checkout_url, null, 'no URL once paid');
  equal(
    calls.find((call) => call.name === 'apply_reservation_deposit_callback')?.args,
    {
      p_provider: 'STRIPE',
      p_event_id: 'read:cs_test_1:COMPLETED',
      p_provider_reference: 'cs_test_1',
      p_state: 'COMPLETED',
    },
    'callback args',
  );
});

Deno.test('an already settled deposit reports the outcome without a new checkout', async () => {
  const { deps, providerCalls } = fakeDeps({
    begin_reservation_deposit: [{ error: { message: 'DEPOSIT_NOT_PENDING' } }],
    get_reservation_deposit_status: [
      { data: base({ deposit_status: 'COMPLETED', reservation_status: 'RESERVED' }) },
    ],
  });
  equal((await startCheckout(deps, start)).state, 'COMPLETED', 'settled');
  equal(providerCalls, [], 'no provider contacted');
});

Deno.test('status re-reads the provider, then answers from the database', async () => {
  const { deps } = fakeDeps(
    {
      get_reservation_deposit_status: [
        { data: base({ provider_reference: 'cs_test_1' }) },
        {
          data: base({
            provider_reference: 'cs_test_1',
            deposit_status: 'COMPLETED',
            reservation_status: 'RESERVED',
          }),
        },
      ],
      apply_reservation_deposit_callback: [{ data: {} }],
    },
    { read: () => Promise.resolve(payment({ state: 'COMPLETED' })) },
  );
  const result = await depositStatus(deps, {
    action: 'status',
    deposit_id: depositId,
    access_token: token,
  });
  equal(result.outcome, 'CONFIRMED', 'confirmed');
  assert(!('provider_reference' in result), 'provider reference never reaches the browser');
});

Deno.test('a payment after expiry is handed to the admin, never kept silently', async () => {
  const { deps, calls } = fakeDeps(
    {
      get_reservation_deposit_status: [
        { data: base({ provider_reference: 'cs_test_1' }) },
        {
          data: base({ provider_reference: 'cs_test_1', deposit_status: 'PENDING' }),
        },
      ],
      apply_reservation_deposit_callback: [{ error: { message: 'DEPOSIT_EXPIRED' } }],
      record_reservation_deposit_late_payment: [{ data: {} }],
    },
    { read: () => Promise.resolve(payment({ state: 'COMPLETED' })) },
  );
  const result = await depositStatus(deps, {
    action: 'status',
    deposit_id: depositId,
    access_token: token,
  });
  equal(result.outcome, 'RECONCILIATION_REQUIRED', 'late payment');
  assert(
    calls.some((call) => call.name === 'record_reservation_deposit_late_payment'),
    'admin not told',
  );
});

Deno.test(
  'webhook reconciliation trusts only the bound reference and the provider read',
  async () => {
    const bound = base({ provider_reference: 'cs_test_1' });
    const wrong = fakeDeps({ get_reservation_deposit_for_provider: [{ data: bound }] });
    await rejects(
      () => reconcileDeposit(wrong.deps, depositId, 'STRIPE', 'cs_forged'),
      'PROVIDER_VERIFICATION_FAILED',
      'forged session id',
    );
    equal(wrong.providerCalls, [], 'no read for a forged event');
    const satispay = fakeDeps({ get_reservation_deposit_for_provider: [{ data: bound }] });
    await rejects(
      () => reconcileDeposit(satispay.deps, depositId, 'SATISPAY'),
      'PROVIDER_VERIFICATION_FAILED',
      'provider mismatch',
    );
    const ok = fakeDeps(
      {
        get_reservation_deposit_for_provider: [{ data: bound }],
        apply_reservation_deposit_callback: [{ data: {} }],
      },
      { read: () => Promise.resolve(payment({ state: 'COMPLETED' })) },
    );
    equal(await reconcileDeposit(ok.deps, depositId, 'STRIPE', 'cs_test_1'), 'COMPLETED', 'paid');
    const done = fakeDeps({
      get_reservation_deposit_for_provider: [{ data: { ...bound, deposit_status: 'COMPLETED' } }],
    });
    equal(await reconcileDeposit(done.deps, depositId, 'STRIPE'), 'IGNORED', 'duplicate event');
    equal(done.providerCalls, [], 'no read when already settled');
  },
);

Deno.test('guest outcome follows the server states', () => {
  equal(guestOutcome(base()), 'PENDING', 'pending');
  equal(
    guestOutcome(base({ deposit_status: 'COMPLETED', reservation_status: 'RESERVED' })),
    'CONFIRMED',
    'paid',
  );
  equal(
    guestOutcome(base({ deposit_status: 'REFUNDED', reservation_status: 'COMPLETED' })),
    'CONFIRMED',
    'refunded after the meal',
  );
  equal(guestOutcome(base({ deposit_status: 'EXPIRED' })), 'EXPIRED', 'expired');
  equal(guestOutcome(base({ deposit_status: 'FAILED' })), 'FAILED', 'failed');
});

Deno.test('provider payload mapping', () => {
  const session = {
    id: 'cs_test_1',
    object: 'checkout.session',
    amount_total: 2000,
    currency: 'eur',
    payment_status: 'unpaid',
    status: 'open',
    url: 'https://checkout.stripe.com/c/pay/cs_test_1',
    metadata: { deposit_id: depositId },
    livemode: false,
  };
  equal(mapStripeDepositSession(session, false).state, 'WAITING', 'open');
  equal(
    mapStripeDepositSession({ ...session, payment_status: 'paid' }, false).state,
    'COMPLETED',
    'paid',
  );
  equal(
    mapStripeDepositSession({ ...session, status: 'expired' }, false).state,
    'FAILED',
    'expired',
  );
  let threw = false;
  try {
    mapStripeDepositSession(session, true);
  } catch {
    threw = true;
  }
  assert(threw, 'test session accepted in live mode');
  const satispay = {
    id: 'sp_1',
    amount_unit: 2000,
    currency: 'EUR',
    status: 'PENDING',
    external_code: depositId,
    redirect_url: 'https://staging-online.satispay.com/pay/sp_1',
  };
  equal(mapSatispayDeposit(satispay, depositId, 'test').depositReference, depositId, 'echo');
  threw = false;
  try {
    mapSatispayDeposit(
      { ...satispay, redirect_url: 'https://evil.example/pay' },
      depositId,
      'test',
    );
  } catch {
    threw = true;
  }
  assert(threw, 'foreign redirect accepted');
  equal(
    mapSatispayDeposit({ ...satispay, status: 'ACCEPTED' }, depositId, 'test').state,
    'COMPLETED',
    'accepted',
  );
});

Deno.test('Stripe session expiry stays inside the provider window', () => {
  const now = Date.parse('2026-10-21T20:00:00Z');
  equal(
    stripeSessionExpiry('2026-10-21T20:10:00Z', now),
    now / 1000 + 31 * 60,
    'at least 31 minutes',
  );
  equal(stripeSessionExpiry('2026-10-21T20:45:00Z', now), now / 1000 + 45 * 60, 'deposit expiry');
  equal(stripeSessionExpiry('2026-10-30T20:00:00Z', now), now / 1000 + 23 * 3600, 'at most 23 h');
});

Deno.test('return URL is the public booking page with venue and deposit', () => {
  equal(
    depositReturnUrl('https://ristorante.example/prenota', base()),
    `https://ristorante.example/prenota?sede=centro&deposito=${depositId}`,
    'url',
  );
  for (const bad of [undefined, 'http://ristorante.example/prenota', 'https://x.example/?a=1'])
    try {
      depositReturnUrl(bad, base());
      throw new Error('accepted');
    } catch (error) {
      equal((error as Error).message, 'SERVER_CONFIGURATION_REQUIRED', String(bad));
    }
});

Deno.test(
  'deposit webhook events and callback tokens are separate from bill payments',
  async () => {
    const event = JSON.stringify({
      id: 'evt_1',
      type: 'checkout.session.completed',
      data: { object: { id: 'cs_test_1', metadata: { deposit_id: depositId } } },
    });
    equal(stripeDepositEvent(event)?.deposit, depositId, 'deposit event');
    const bill = JSON.stringify({
      id: 'evt_2',
      type: 'checkout.session.completed',
      data: { object: { id: 'cs_test_2', metadata: { operation_id: depositId } } },
    });
    equal(stripeDepositEvent(bill), null, 'bill payment untouched');
    const secret = 's'.repeat(40);
    assert(
      (await satispayDepositCallbackToken(depositId, secret)) !==
        (await satispayCallbackToken(depositId, secret)),
      'deposit token reusable as an operation token',
    );
  },
);
