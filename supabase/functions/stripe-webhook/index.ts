import {
  reconcileStripeEvent,
  verifyStripeSignature,
  stripeWebhookSecret,
  venueSecret,
} from '../_shared/providers.ts';
import { serverClient } from '../_shared/http.ts';
import { reconcileDeposit } from '../_shared/deposits.ts';
import {
  depositCheckoutEvents,
  depositGateway,
  stripeDepositEvent,
} from '../_shared/deposit-providers.ts';
import { z } from 'npm:zod@4.6.5';

// Booking deposits (metadata.deposit_id, no operation_id): verified with the deposit venue's
// signing secret, then the Checkout Session is re-read from Stripe; the event body never decides.
async function depositEvent(raw: string, signature: string): Promise<Response | null> {
  const event = stripeDepositEvent(raw);
  if (!event) return null;
  const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
  const server = serverClient();
  const { data, error } = await server.rpc('get_reservation_deposit_for_provider', {
    p_deposit: event.deposit,
  });
  if (error || !data) throw new Error('PROVIDER_VERIFICATION_FAILED');
  const deposit = z.object({ venue_id: z.uuid(), provider: z.string().nullable() }).parse(data);
  if (deposit.provider !== 'STRIPE') throw new Error('PROVIDER_VERIFICATION_FAILED');
  if (
    !(await verifyStripeSignature(
      raw,
      signature,
      venueSecret('STRIPE_WEBHOOK_SECRET', deposit.venue_id),
    ))
  )
    return new Response(null, { status: 401, headers });
  if (depositCheckoutEvents.includes(event.type))
    await reconcileDeposit(
      { rpc: (name, args) => server.rpc(name, args), gateway: depositGateway },
      event.deposit,
      'STRIPE',
      event.object,
    );
  return new Response(JSON.stringify({ received: true }), { headers });
}
Deno.serve(async (request) => {
  if (request.method !== 'POST') return new Response(null, { status: 405 });
  const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
  try {
    const limit = 262144;
    if (Number(request.headers.get('content-length')) > limit || !request.body)
      return new Response(null, { status: 413, headers });
    const reader = request.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.byteLength;
        if (size > limit) {
          await reader.cancel();
          return new Response(null, { status: 413, headers });
        }
        chunks.push(next.value);
      }
    } finally {
      reader.releaseLock();
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const deposit = await depositEvent(raw, request.headers.get('stripe-signature') ?? '');
    if (deposit) return deposit;
    if (
      !(await verifyStripeSignature(
        raw,
        request.headers.get('stripe-signature') ?? '',
        await stripeWebhookSecret(raw),
      ))
    )
      return new Response(null, { status: 401, headers });
    return new Response(JSON.stringify(await reconcileStripeEvent(raw)), { headers });
  } catch {
    return new Response(JSON.stringify({ received: false }), { status: 503, headers });
  }
});
