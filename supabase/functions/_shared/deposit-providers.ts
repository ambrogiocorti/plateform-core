// Provider adapters for large-group booking deposits. Same request rules as _shared/providers.ts
// (per-venue secrets, mode/key coherence, pinned Stripe version, signed Satispay requests, no
// redirects, bounded responses) and the same idempotency: the deposit id is the provider key, so a
// replayed create returns the same checkout instead of charging twice.
import { z } from 'npm:zod@4.6.5';
import { secret } from './http.ts';
import {
  isAllowedSatispayRedirect,
  satispay,
  satispayDepositCallbackToken,
  stripe,
  venueSecret,
} from './providers.ts';
import {
  type DepositGateway,
  type DepositProvider,
  type DepositRecord,
  depositReturnUrl,
  type ProviderPayment,
} from './deposits.ts';

const stripeSessionSchema = z.object({
  id: z.string().min(1).max(240),
  object: z.literal('checkout.session'),
  amount_total: z.number().int(),
  currency: z.string(),
  payment_status: z.string(),
  status: z.string(),
  url: z.url().nullable().optional(),
  metadata: z.record(z.string(), z.string()).nullable().optional(),
  livemode: z.boolean(),
});

const satispaySchema = z.object({
  id: z.string().min(1).max(240),
  amount_unit: z.number().int(),
  currency: z.string(),
  status: z.string(),
  redirect_url: z.url().optional(),
  external_code: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).nullable().optional(),
});

/** Maps a Checkout Session read from Stripe. Fails closed on a test/live mismatch. */
export function mapStripeDepositSession(payload: unknown, live: boolean): ProviderPayment {
  const session = stripeSessionSchema.parse(payload);
  if (session.livemode !== live) throw new Error('PROVIDER_VERIFICATION_FAILED');
  const state =
    session.payment_status === 'paid'
      ? 'COMPLETED'
      : session.status === 'expired'
        ? 'FAILED'
        : 'WAITING';
  return {
    reference: session.id,
    state,
    amountCents: session.amount_total,
    currency: session.currency.toUpperCase(),
    depositReference: session.metadata?.deposit_id ?? null,
    checkoutUrl: state === 'WAITING' ? (session.url ?? null) : null,
  };
}

/** Maps a Satispay payment; a checkout redirect must be on the mode's Satispay host. */
export function mapSatispayDeposit(
  payload: unknown,
  depositId: string,
  mode: string,
): ProviderPayment {
  const payment = satispaySchema.parse(payload);
  const state =
    payment.status === 'ACCEPTED'
      ? 'COMPLETED'
      : payment.status === 'CANCELED'
        ? 'FAILED'
        : 'WAITING';
  const echoed = payment.external_code === depositId || payment.metadata?.deposit_id === depositId;
  let checkoutUrl: string | null = null;
  if (state === 'WAITING' && payment.redirect_url) {
    if (!isAllowedSatispayRedirect(payment.redirect_url, mode))
      throw new Error('PROVIDER_VERIFICATION_FAILED');
    checkoutUrl = payment.redirect_url;
  }
  return {
    reference: payment.id,
    state,
    amountCents: payment.amount_unit,
    currency: payment.currency.toUpperCase(),
    depositReference: echoed ? depositId : null,
    checkoutUrl,
  };
}

/** Stripe accepts a session expiry between 30 minutes and 24 hours from now. */
export function stripeSessionExpiry(depositExpiresAt: string, now = Date.now()): number {
  const target = Math.floor(Date.parse(depositExpiresAt) / 1000);
  const seconds = Math.floor(now / 1000);
  if (!Number.isFinite(target)) throw new Error('INVALID_DEPOSIT');
  return Math.min(Math.max(target, seconds + 31 * 60), seconds + 23 * 3600);
}

function mode(venue: string): 'test' | 'live' {
  const value = venueSecret('PAYMENTS_MODE', venue);
  if (value !== 'test' && value !== 'live') throw new Error('SERVER_CONFIGURATION_REQUIRED');
  return value;
}

const returnUrl = (deposit: DepositRecord) =>
  depositReturnUrl(Deno.env.get('DEPOSIT_RETURN_URL'), deposit);

async function providerCall<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    const code = error instanceof Error ? error.message : '';
    throw new Error(
      code === 'SERVER_CONFIGURATION_REQUIRED' || code === 'PROVIDER_VERIFICATION_FAILED'
        ? code
        : 'PROVIDER_REQUEST_FAILED',
    );
  }
}

export const depositGateway: DepositGateway = {
  create(provider: DepositProvider, deposit: DepositRecord) {
    return providerCall(async () => {
      const venue = deposit.venue_id;
      if (provider === 'STRIPE') {
        const back = returnUrl(deposit);
        const form = new URLSearchParams({
          mode: 'payment',
          success_url: back,
          cancel_url: back,
          client_reference_id: deposit.deposit_id,
          expires_at: String(stripeSessionExpiry(deposit.expires_at)),
          'metadata[deposit_id]': deposit.deposit_id,
          'metadata[reservation_id]': deposit.reservation_id,
          'payment_intent_data[metadata][deposit_id]': deposit.deposit_id,
          'line_items[0][quantity]': '1',
          'line_items[0][price_data][currency]': 'eur',
          'line_items[0][price_data][unit_amount]': String(deposit.amount_cents),
          'line_items[0][price_data][product_data][name]':
            'Caparra di garanzia per la prenotazione di gruppo',
        });
        return mapStripeDepositSession(
          await stripe(venue, 'checkout/sessions', form, `deposit:${deposit.deposit_id}`),
          mode(venue) === 'live',
        );
      }
      const callback = new URL('/functions/v1/satispay-callback', secret('SUPABASE_URL'));
      callback.searchParams.set('deposit', deposit.deposit_id);
      callback.searchParams.set(
        'token',
        await satispayDepositCallbackToken(deposit.deposit_id, secret('SATISPAY_CALLBACK_TOKEN')),
      );
      return mapSatispayDeposit(
        await satispay(
          venue,
          '',
          {
            flow: 'MATCH_CODE',
            amount_unit: deposit.amount_cents,
            currency: 'EUR',
            external_code: deposit.deposit_id,
            metadata: { deposit_id: deposit.deposit_id },
            callback_url: callback.toString(),
            redirect_url: returnUrl(deposit),
          },
          `deposit:${deposit.deposit_id}`,
        ),
        deposit.deposit_id,
        mode(venue),
      );
    });
  },
  read(provider: DepositProvider, deposit: DepositRecord, reference: string) {
    return providerCall(async () => {
      const venue = deposit.venue_id;
      if (provider === 'STRIPE')
        return mapStripeDepositSession(
          await stripe(venue, `checkout/sessions/${encodeURIComponent(reference)}`),
          mode(venue) === 'live',
        );
      return mapSatispayDeposit(
        await satispay(venue, `/${encodeURIComponent(reference)}`),
        deposit.deposit_id,
        mode(venue),
      );
    });
  },
};

/** Stripe events for a deposit carry metadata.deposit_id on the Checkout Session. */
export function stripeDepositEvent(
  raw: string,
): { id: string; type: string; deposit: string; object: string } | null {
  const parsed = z
    .object({
      id: z.string(),
      type: z.string(),
      data: z.object({
        object: z.object({
          id: z.string(),
          object: z.string().optional(),
          metadata: z
            .object({ deposit_id: z.uuid().optional(), operation_id: z.string().optional() })
            .passthrough()
            .nullable()
            .optional(),
        }),
      }),
    })
    .safeParse(JSON.parse(raw));
  if (!parsed.success) return null;
  const metadata = parsed.data.data.object.metadata;
  if (!metadata?.deposit_id || metadata.operation_id) return null;
  return {
    id: parsed.data.id,
    type: parsed.data.type,
    deposit: metadata.deposit_id,
    object: parsed.data.data.object.id,
  };
}

export const depositCheckoutEvents = [
  'checkout.session.completed',
  'checkout.session.async_payment_succeeded',
  'checkout.session.async_payment_failed',
  'checkout.session.expired',
];
