import {
  depositReturnUrl,
  guestOutcome,
  reconcileDeposit,
  requestSchema,
  settle,
  startCheckout,
  type DepositDeps,
  type DepositRecord,
  type ProviderPayment,
} from '../_shared/deposits.ts';
import {
  mapStripeDepositSession,
  mapSatispayDeposit,
  stripeSessionExpiry,
} from '../_shared/deposit-providers.ts';
import { satispayCallbackToken, satispayDepositCallbackToken } from '../_shared/providers.ts';
import { validWorkerToken } from '../reservation-deposit-no-show-worker/worker.ts';
import { environmentAllowed } from '../database-unavailable-chaos-probe/probe.ts';

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
async function rejects(action: () => unknown, code: string) {
  try {
    await action();
  } catch (error) {
    assert(error instanceof Error && error.message.includes(code), `Expected ${code}`);
    return;
  }
  throw new Error(`Expected rejection: ${code}`);
}
const id = '10000000-0000-4000-8000-000000000001';
const record: DepositRecord = {
  deposit_id: id,
  reservation_id: '10000000-0000-4000-8000-000000000002',
  venue_id: '10000000-0000-4000-8000-000000000003',
  venue_slug: 'ristorante',
  deposit_status: 'PENDING',
  reservation_status: 'PENDING_DEPOSIT',
  provider: 'STRIPE',
  provider_reference: null,
  amount_cents: 2000,
  currency: 'EUR',
  expires_at: '2026-11-04T20:00:00Z',
};
const payment: ProviderPayment = {
  reference: 'cs_test_deposit',
  state: 'WAITING',
  amountCents: 2000,
  currency: 'EUR',
  depositReference: id,
  checkoutUrl: 'https://checkout.stripe.com/pay/test',
};
const request = {
  action: 'start' as const,
  deposit_id: id,
  access_token: 'a'.repeat(64),
  provider: 'STRIPE' as const,
  idempotency_key: '10000000-0000-4000-8000-000000000004',
};

function fixture(
  overrides: { record?: DepositRecord; payment?: ProviderPayment; beginError?: string } = {},
) {
  const calls: string[] = [];
  const deps: DepositDeps = {
    rpc: async (name) => {
      calls.push(name);
      if (name === 'begin_reservation_deposit' && overrides.beginError)
        return { data: null, error: { message: overrides.beginError } };
      return {
        data:
          name === 'get_reservation_deposit_status' ||
          name === 'get_reservation_deposit_for_provider'
            ? (overrides.record ?? record)
            : {},
        error: null,
      };
    },
    gateway: {
      create: async () => {
        calls.push('CREATE');
        return overrides.payment ?? payment;
      },
      read: async () => {
        calls.push('READ');
        return overrides.payment ?? payment;
      },
    },
  };
  return { calls, deps };
}

Deno.test('guest checkout rejects client amounts, authority fields and malformed tokens', () => {
  assert(requestSchema.safeParse(request).success, 'Valid request rejected');
  for (const body of [
    { ...request, amount_cents: 1 },
    { ...request, access_token: 'short' },
    { ...request, provider: 'CASH' },
    { ...request, role: 'service_role' },
  ])
    assert(!requestSchema.safeParse(body).success, 'Unsafe request accepted');
});
for (const code of [
  'BOOKING_DEPOSITS_DISABLED',
  'DEPOSIT_PROVIDER_UNAVAILABLE',
  'DEPOSIT_ACCESS_DENIED',
]) {
  Deno.test(`database denial ${code} prevents all provider side effects`, async () => {
    const { deps, calls } = fixture({ beginError: code });
    await rejects(
      () => startCheckout(deps, request),
      code === 'DEPOSIT_ACCESS_DENIED' ? 'FORBIDDEN' : code,
    );
    assert(
      calls.join(',') === 'begin_reservation_deposit',
      'Provider called after denied licence/token',
    );
  });
}
Deno.test('waiting checkout binds its resource without confirming the payment', async () => {
  const { deps, calls } = fixture();
  const result = await startCheckout(deps, request);
  assert(result.state === 'WAITING' && result.deposit_id === id, 'Wrong checkout state');
  assert(
    calls.indexOf('CREATE') < calls.indexOf('bind_reservation_deposit_provider_reference'),
    'Binding order wrong',
  );
  assert(!calls.includes('apply_reservation_deposit_callback'), 'Unpaid checkout confirmed');
});
Deno.test('resuming a known resource reads it without creating another payment', async () => {
  const { deps, calls } = fixture({ record: { ...record, provider_reference: payment.reference } });
  await startCheckout(deps, request);
  assert(calls.includes('READ') && !calls.includes('CREATE'), 'Duplicate checkout');
});
Deno.test('a different provider amount cannot be bound or settled', async () => {
  const { deps, calls } = fixture({ payment: { ...payment, amountCents: 1 } });
  await rejects(() => startCheckout(deps, request), 'PROVIDER_VERIFICATION_FAILED');
  assert(
    !calls.includes('bind_reservation_deposit_provider_reference') &&
      !calls.includes('apply_reservation_deposit_callback'),
    'Unverified cents committed',
  );
});
Deno.test('callback resource mismatch stops before the provider read', async () => {
  const { deps, calls } = fixture({ record: { ...record, provider_reference: payment.reference } });
  await rejects(
    () => reconcileDeposit(deps, id, 'STRIPE', 'cs_other'),
    'PROVIDER_VERIFICATION_FAILED',
  );
  assert(!calls.includes('READ'), 'Forged callback followed');
});
Deno.test('a verified late payment creates an explicit reconciliation task', async () => {
  const { deps, calls } = fixture();
  deps.rpc = async (name) => {
    calls.push(name);
    return {
      data: {},
      error: name === 'apply_reservation_deposit_callback' ? { message: 'DEPOSIT_EXPIRED' } : null,
    };
  };
  const outcome = await settle(deps, record, 'STRIPE', { ...payment, state: 'COMPLETED' });
  assert(
    outcome === 'RECONCILIATION_REQUIRED' &&
      calls.includes('record_reservation_deposit_late_payment'),
    'Late payment lost',
  );
});
Deno.test('paid deposits never reconfirm cancelled, no-show or inconsistent bookings', () => {
  assert(
    guestOutcome({ ...record, deposit_status: 'COMPLETED', reservation_status: 'CANCELLED' }) ===
      'CANCELLED',
    'Cancelled booking confirmed',
  );
  assert(
    guestOutcome({ ...record, deposit_status: 'COMPLETED', reservation_status: 'NO_SHOW' }) ===
      'NO_SHOW',
    'No-show booking confirmed',
  );
  assert(
    guestOutcome({ ...record, deposit_status: 'COMPLETED', reservation_status: 'RESERVED' }) ===
      'CONFIRMED',
    'Valid confirmation lost',
  );
  assert(
    guestOutcome({ ...record, deposit_status: 'COMPLETED' }) === 'RECONCILIATION_REQUIRED',
    'Inconsistent state confirmed',
  );
});
Deno.test('return URL includes only deposit id and venue, never the guest capability', () => {
  const url = new URL(depositReturnUrl('https://restaurant.test/prenota', record));
  assert(
    url.searchParams.get('deposito') === id && url.searchParams.get('sede') === 'ristorante',
    'Return route lost',
  );
  assert(!url.href.includes(request.access_token), 'Capability leaked');
});
Deno.test('provider mappers reject test/live mismatches and unsafe payment redirects', async () => {
  await rejects(
    () =>
      mapStripeDepositSession(
        {
          id: payment.reference,
          object: 'checkout.session',
          amount_total: 2000,
          currency: 'eur',
          payment_status: 'unpaid',
          status: 'open',
          livemode: true,
        },
        false,
      ),
    'PROVIDER_VERIFICATION_FAILED',
  );
  await rejects(
    () =>
      mapSatispayDeposit(
        {
          id: 'satispay-id',
          amount_unit: 2000,
          currency: 'EUR',
          status: 'PENDING',
          redirect_url: 'https://evil.test',
          external_code: id,
        },
        id,
        'test',
      ),
    'PROVIDER_VERIFICATION_FAILED',
  );
});
Deno.test('Stripe expiration remains within provider bounds for short reservation holds', () => {
  const now = Date.parse('2026-11-03T12:00:00Z');
  const expiry = stripeSessionExpiry('2026-11-03T12:10:00Z', now);
  assert(expiry >= now / 1000 + 30 * 60 && expiry <= now / 1000 + 24 * 3600, 'Invalid expiry');
});
Deno.test('Satispay deposit callbacks use a separate HMAC purpose', async () => {
  const key = 's'.repeat(64);
  assert(
    (await satispayCallbackToken(id, key)) !== (await satispayDepositCallbackToken(id, key)),
    'Callback token collision',
  );
});
Deno.test('refund workers require a strong exact server token', async () => {
  const key = 's'.repeat(64);
  assert(await validWorkerToken(key, key), 'Correct token denied');
  assert(!(await validWorkerToken('x'.repeat(64), key)), 'Forged token accepted');
  assert(!(await validWorkerToken('', '')), 'Missing token accepted');
});
Deno.test('database chaos probes require an explicit non-production environment', () => {
  for (const value of [undefined, null, '', 'production', 'prod', 'production-eu', 'unknown'])
    assert(!environmentAllowed(value), 'Unsafe chaos environment accepted');
  for (const value of ['development', 'staging', 'test', 'local', ' STAGING '])
    assert(environmentAllowed(value), 'Explicit test environment denied');
});
