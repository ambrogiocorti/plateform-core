import {
  reconcileStripeEvent,
  verifyStripeSignature,
  stripeWebhookSecret,
} from '../_shared/providers.ts';
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
