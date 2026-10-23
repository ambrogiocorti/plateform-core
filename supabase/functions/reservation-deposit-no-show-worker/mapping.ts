// Pure mapping of provider payloads to the worker's refund model (no network).
import { z } from 'npm:zod@4.6.5';
import { ProviderError, type ProviderRefund } from './worker.ts';

const stripeRefundSchema = z.object({
  id: z.string().min(1),
  object: z.literal('refund').optional(),
  amount: z.number().int(),
  currency: z.string(),
  status: z.string(),
  failure_reason: z.string().nullable().optional(),
  metadata: z.record(z.string(), z.string()).nullable().optional(),
});

const stripeCheckoutSchema = z.object({
  id: z.string(),
  object: z.literal('checkout.session'),
  payment_status: z.string(),
  payment_intent: z.string().nullable().optional(),
  livemode: z.boolean(),
});

const satispayRefundSchema = z.object({
  id: z.string().min(1),
  amount_unit: z.number().int(),
  currency: z.string(),
  status: z.string(),
  external_code: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).nullable().optional(),
});

export const METADATA_KEY = 'no_show_action_id';

export function mapStripeRefund(payload: unknown): ProviderRefund {
  const parsed = stripeRefundSchema.safeParse(payload);
  if (!parsed.success) throw new ProviderError('PROVIDER_VERIFICATION_FAILED');
  const refund = parsed.data;
  const state =
    refund.status === 'succeeded'
      ? 'COMPLETED'
      : ['failed', 'canceled'].includes(refund.status)
        ? 'FAILED'
        : 'WAITING';
  return {
    id: refund.id,
    state,
    amountCents: refund.amount,
    currency: refund.currency.toUpperCase(),
    actionReference: refund.metadata?.[METADATA_KEY] ?? null,
    ...(state === 'FAILED'
      ? {
          failureCode: `STRIPE_REFUND_${(refund.failure_reason ?? refund.status)
            .toUpperCase()
            .replace(/[^A-Z0-9_]/g, '_')}`.slice(0, 160),
        }
      : {}),
  };
}

/** Resolves the PaymentIntent to refund from a deposit provider reference. */
export function stripeRefundTarget(reference: string): {
  kind: 'checkout_session' | 'payment_intent' | 'charge';
  id: string;
} {
  if (/^cs_[A-Za-z0-9_]+$/.test(reference)) return { kind: 'checkout_session', id: reference };
  if (/^pi_[A-Za-z0-9_]+$/.test(reference)) return { kind: 'payment_intent', id: reference };
  if (/^(ch|py)_[A-Za-z0-9_]+$/.test(reference)) return { kind: 'charge', id: reference };
  throw new ProviderError('INVALID_PROVIDER_REFERENCE');
}

export function paymentIntentFromCheckout(payload: unknown, live: boolean): string {
  const parsed = stripeCheckoutSchema.safeParse(payload);
  if (
    !parsed.success ||
    parsed.data.livemode !== live ||
    parsed.data.payment_status !== 'paid' ||
    !parsed.data.payment_intent
  )
    throw new ProviderError('PROVIDER_VERIFICATION_FAILED');
  return parsed.data.payment_intent;
}

export function mapSatispayRefund(payload: unknown, actionId: string): ProviderRefund {
  const parsed = satispayRefundSchema.safeParse(payload);
  if (!parsed.success) throw new ProviderError('PROVIDER_VERIFICATION_FAILED');
  const payment = parsed.data;
  const state =
    payment.status === 'ACCEPTED'
      ? 'COMPLETED'
      : payment.status === 'CANCELED'
        ? 'FAILED'
        : 'WAITING';
  const echoed =
    payment.external_code === actionId || payment.metadata?.[METADATA_KEY] === actionId;
  return {
    id: payment.id,
    state,
    amountCents: payment.amount_unit,
    currency: payment.currency.toUpperCase(),
    actionReference: echoed ? actionId : null,
    ...(state === 'FAILED' ? { failureCode: 'SATISPAY_REFUND_CANCELED' } : {}),
  };
}
