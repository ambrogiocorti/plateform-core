// Provider HTTP adapters for no-show deposit refunds. Mirrors the request rules of
// _shared/providers.ts (per-venue secrets, mode/key coherence, pinned Stripe version, signed
// Satispay requests, no redirects, 15 s timeout, bounded body) and reuses its exported signer.
import { satispayHeaders } from '../_shared/providers.ts';
import {
  mapSatispayRefund,
  mapStripeRefund,
  METADATA_KEY,
  paymentIntentFromCheckout,
  stripeRefundTarget,
} from './mapping.ts';
import { type ClaimedAction, ProviderError, type RefundProvider } from './worker.ts';

/** Same lookup as _shared/providers.ts: NAME_<VENUEUUIDUPPER> or the single-venue NAME. */
function venueSecret(name: string, venue: string): string {
  const configured = Deno.env.get(`${name}_${venue.replaceAll('-', '').toUpperCase()}`);
  if (configured) return configured;
  if (Deno.env.get('PAYMENTS_VENUE_ID') === venue) {
    const value = Deno.env.get(name);
    if (value) return value;
  }
  throw new ProviderError('PROVIDER_CONFIGURATION_REQUIRED');
}

function paymentsMode(venue: string): 'test' | 'live' {
  const mode = venueSecret('PAYMENTS_MODE', venue);
  if (mode !== 'test' && mode !== 'live')
    throw new ProviderError('PROVIDER_CONFIGURATION_REQUIRED');
  return mode;
}

async function providerFetch(url: URL, options: RequestInit): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, {
      ...options,
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw new ProviderError('PROVIDER_UNAVAILABLE');
  }
  let raw: string;
  try {
    raw = await response.text();
  } catch {
    throw new ProviderError('PROVIDER_UNAVAILABLE');
  }
  // 408/409/425/429/5xx: the provider may still be processing (or replaying) the request.
  if (!response.ok)
    throw new ProviderError(
      response.status >= 500 || [408, 409, 425, 429].includes(response.status)
        ? 'PROVIDER_UNAVAILABLE'
        : 'PROVIDER_REQUEST_REJECTED',
    );
  if (raw.length > 262144) throw new ProviderError('PROVIDER_VERIFICATION_FAILED');
  try {
    return JSON.parse(raw);
  } catch {
    throw new ProviderError('PROVIDER_VERIFICATION_FAILED');
  }
}

function stripeRequest(
  venue: string,
  path: string,
  body?: URLSearchParams,
  key?: string,
): Promise<unknown> {
  const mode = paymentsMode(venue);
  const token = venueSecret('STRIPE_SECRET_KEY', venue);
  if (!token.startsWith(mode === 'live' ? 'sk_live_' : 'sk_test_'))
    throw new ProviderError('PROVIDER_CONFIGURATION_REQUIRED');
  const headers = new Headers({
    Authorization: `Bearer ${token}`,
    'Stripe-Version': '2025-06-30.basil',
  });
  if (body) headers.set('Content-Type', 'application/x-www-form-urlencoded');
  if (key) headers.set('Idempotency-Key', key);
  return providerFetch(new URL(`https://api.stripe.com/v1/${path}`), {
    method: body ? 'POST' : 'GET',
    headers,
    ...(body ? { body } : {}),
  });
}

async function satispayRequest(
  venue: string,
  path: string,
  body?: Record<string, unknown>,
  key?: string,
): Promise<unknown> {
  const mode = paymentsMode(venue);
  const base = venueSecret('SATISPAY_API_BASE_URL', venue);
  if (
    base !==
    (mode === 'live'
      ? 'https://authservices.satispay.com'
      : 'https://staging.authservices.satispay.com')
  )
    throw new ProviderError('PROVIDER_CONFIGURATION_REQUIRED');
  const url = new URL(`/g_business/v1/payments${path}`, base);
  const encoded = body ? JSON.stringify(body) : '';
  let headers: Headers;
  try {
    headers = await satispayHeaders(
      body ? 'POST' : 'GET',
      url,
      encoded,
      venueSecret('SATISPAY_KEY_ID', venue),
      venueSecret('SATISPAY_PRIVATE_KEY_PKCS8', venue),
    );
  } catch {
    throw new ProviderError('PROVIDER_CONFIGURATION_REQUIRED');
  }
  if (key) headers.set('Idempotency-Key', key);
  return providerFetch(url, {
    method: body ? 'POST' : 'GET',
    headers,
    ...(body ? { body: encoded } : {}),
  });
}

export const stripeRefunds: RefundProvider = {
  async createRefund(action: ClaimedAction) {
    const venue = action.venue_id;
    const target = stripeRefundTarget(action.provider_payment_id!);
    const form = new URLSearchParams({
      amount: String(action.amount_cents),
      [`metadata[${METADATA_KEY}]`]: action.provider_idempotency_key,
      'metadata[deposit_id]': action.deposit_id,
      'metadata[reservation_id]': action.reservation_id,
    });
    if (target.kind === 'charge') form.set('charge', target.id);
    else if (target.kind === 'payment_intent') form.set('payment_intent', target.id);
    else {
      const session = await stripeRequest(
        venue,
        `checkout/sessions/${encodeURIComponent(target.id)}`,
      );
      form.set(
        'payment_intent',
        paymentIntentFromCheckout(session, paymentsMode(venue) === 'live'),
      );
    }
    // Idempotency-Key = action id (claim.provider_idempotency_key): a replay returns the same refund.
    return mapStripeRefund(
      await stripeRequest(venue, 'refunds', form, action.provider_idempotency_key),
    );
  },
  async readRefund(action: ClaimedAction, refundId: string) {
    return mapStripeRefund(
      await stripeRequest(action.venue_id, `refunds/${encodeURIComponent(refundId)}`),
    );
  },
};

export const satispayRefunds: RefundProvider = {
  async createRefund(action: ClaimedAction) {
    const id = action.provider_idempotency_key;
    // No callback_url: satispay-callback reconciles provider_operations only; this worker polls.
    return mapSatispayRefund(
      await satispayRequest(
        action.venue_id,
        '',
        {
          flow: 'REFUND',
          amount_unit: action.amount_cents,
          currency: 'EUR',
          parent_payment_uid: action.provider_payment_id,
          external_code: id,
          metadata: { [METADATA_KEY]: id, deposit_id: action.deposit_id },
        },
        id,
      ),
      id,
    );
  },
  async readRefund(action: ClaimedAction, refundId: string) {
    return mapSatispayRefund(
      await satispayRequest(action.venue_id, `/${encodeURIComponent(refundId)}`),
      action.provider_idempotency_key,
    );
  },
};
