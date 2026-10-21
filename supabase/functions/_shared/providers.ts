import { z } from 'npm:zod@4.6.5';
import { secret, serverClient } from './http.ts';
const bytes = (value: string) => new TextEncoder().encode(value);
const base64 = (value: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(value)));
const base64url = (value: ArrayBuffer) =>
  base64(value).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');

export async function satispayCallbackToken(
  operation: string,
  callbackSecret: string,
): Promise<string> {
  const id = z.uuid().parse(operation);
  if (callbackSecret.length < 32) throw new Error('SERVER_CONFIGURATION_REQUIRED');
  const key = await crypto.subtle.importKey(
    'raw',
    bytes(callbackSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return base64url(await crypto.subtle.sign('HMAC', key, bytes(`satispay-callback:${id}`)));
}

/** Callback token for a booking deposit: a different HMAC message than provider operations. */
export async function satispayDepositCallbackToken(
  deposit: string,
  callbackSecret: string,
): Promise<string> {
  const id = z.uuid().parse(deposit);
  if (callbackSecret.length < 32) throw new Error('SERVER_CONFIGURATION_REQUIRED');
  const key = await crypto.subtle.importKey(
    'raw',
    bytes(callbackSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return base64url(await crypto.subtle.sign('HMAC', key, bytes(`satispay-deposit-callback:${id}`)));
}

export function isAllowedSatispayRedirect(value: string, mode: string): boolean {
  try {
    const url = new URL(value);
    const allowed =
      mode === 'live'
        ? new Set(['online.satispay.com'])
        : mode === 'test'
          ? new Set(['staging-online.satispay.com', 'staging.online.satispay.com'])
          : new Set<string>();
    return (
      url.protocol === 'https:' &&
      allowed.has(url.hostname) &&
      !url.port &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}
export async function verifyStripeSignature(
  raw: string,
  header: string,
  signingSecret: string,
  now = Date.now(),
): Promise<boolean> {
  const entries = header.split(',').map((part) => part.trim().split('='));
  const timestamps = entries.filter((entry) => entry[0] === 't');
  if (timestamps.length !== 1 || !/^\d+$/.test(timestamps[0]?.[1] ?? '')) return false;
  const timestamp = timestamps[0]![1]!;
  if (Math.abs(now / 1000 - Number(timestamp)) > 300) return false;
  const key = await crypto.subtle.importKey(
    'raw',
    bytes(signingSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  for (const entry of entries) {
    if (entry[0] !== 'v1' || !/^[a-f0-9]{64}$/.test(entry[1] ?? '')) continue;
    const signature = Uint8Array.from(entry[1]!.match(/../g)!, (value) => parseInt(value, 16));
    if (await crypto.subtle.verify('HMAC', key, signature, bytes(`${timestamp}.${raw}`)))
      return true;
  }
  return false;
}
export async function satispayHeaders(
  method: string,
  url: URL,
  body: string,
  keyId: string,
  pem: string,
  date = new Date().toUTCString(),
): Promise<Headers> {
  if (!/^[A-Za-z0-9_-]+$/.test(keyId)) throw new Error('SERVER_CONFIGURATION_REQUIRED');
  const digest = `SHA-256=${base64(await crypto.subtle.digest('SHA-256', bytes(body)))}`;
  const signing = `(request-target): ${method.toLowerCase()} ${url.pathname}${url.search}\nhost: ${url.host}\ndate: ${date}\ndigest: ${digest}`;
  const der = Uint8Array.from(
    atob(pem.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g, '')),
    (char) => char.charCodeAt(0),
  );
  const key = await crypto.subtle.importKey(
    'pkcs8',
    der,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = base64(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, bytes(signing)));
  return new Headers({
    'Content-Type': 'application/json',
    Host: url.host,
    Date: date,
    Digest: digest,
    Authorization: `Signature keyId="${keyId}", algorithm="rsa-sha256", headers="(request-target) host date digest", signature="${signature}"`,
  });
}
async function providerFetch(url: URL, options: RequestInit): Promise<unknown> {
  const response = await fetch(url, {
    ...options,
    redirect: 'error',
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error('PROVIDER_REQUEST_FAILED');
  const raw = await response.text();
  if (raw.length > 262144) throw new Error('PROVIDER_RESPONSE_TOO_LARGE');
  return JSON.parse(raw);
}
export function venueSecret(name: string, venue: string): string {
  const configured = Deno.env.get(`${name}_${venue.replaceAll('-', '').toUpperCase()}`);
  if (configured) return configured;
  if (Deno.env.get('PAYMENTS_VENUE_ID') === venue) return secret(name);
  throw new Error('SERVER_CONFIGURATION_REQUIRED');
}
export function stripe(
  venue: string,
  path: string,
  body?: URLSearchParams,
  key?: string,
): Promise<unknown> {
  const token = venueSecret('STRIPE_SECRET_KEY', venue);
  const mode = venueSecret('PAYMENTS_MODE', venue);
  if (
    !['test', 'live'].includes(mode) ||
    !token.startsWith(mode === 'live' ? 'sk_live_' : 'sk_test_')
  )
    throw new Error('SERVER_CONFIGURATION_REQUIRED');
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
export function satispay(
  venue: string,
  path: string,
  body?: Record<string, unknown>,
  key?: string,
): Promise<unknown> {
  return (async () => {
    const base = venueSecret('SATISPAY_API_BASE_URL', venue);
    const mode = venueSecret('PAYMENTS_MODE', venue);
    if (
      base !==
        (mode === 'live'
          ? 'https://authservices.satispay.com'
          : 'https://staging.authservices.satispay.com') ||
      !['test', 'live'].includes(mode)
    )
      throw new Error('SERVER_CONFIGURATION_REQUIRED');
    const url = new URL(`/g_business/v1/payments${path}`, base);
    const encoded = body ? JSON.stringify(body) : '';
    const headers = await satispayHeaders(
      body ? 'POST' : 'GET',
      url,
      encoded,
      venueSecret('SATISPAY_KEY_ID', venue),
      venueSecret('SATISPAY_PRIVATE_KEY_PKCS8', venue),
    );
    if (key) headers.set('Idempotency-Key', key);
    return providerFetch(url, {
      method: body ? 'POST' : 'GET',
      headers,
      ...(body ? { body: encoded } : {}),
    });
  })();
}
const operationSchema = z.object({
  id: z.uuid(),
  state: z.string(),
  kind: z.enum(['PAYMENT', 'REFUND']).optional(),
  method: z.enum(['STRIPE', 'SATISPAY_API']).optional(),
  venue_id: z.uuid().optional(),
  payment_id: z.uuid().optional(),
  amount_cents: z.number().int().positive().optional(),
  currency: z.literal('EUR').optional(),
  lease_token: z.uuid().optional(),
  provider_id: z.string().nullable().optional(),
  original_provider_id: z.string().nullable().optional(),
});
const checkoutSchema = z.object({
  id: z.string(),
  object: z.literal('checkout.session'),
  amount_total: z.number().int(),
  currency: z.string(),
  payment_status: z.string(),
  status: z.string(),
  url: z.url().nullable().optional(),
  payment_intent: z.string().nullable().optional(),
  metadata: z.object({ operation_id: z.uuid() }),
  livemode: z.boolean(),
});
const refundSchema = z.object({
  id: z.string(),
  amount: z.number().int(),
  currency: z.string(),
  status: z.string(),
  metadata: z.object({ operation_id: z.uuid() }),
});
const satispaySchema = z.object({
  id: z.string(),
  amount_unit: z.number().int(),
  currency: z.string(),
  status: z.string(),
  code_identifier: z.string().optional(),
  redirect_url: z.url().optional(),
  metadata: z.object({ operation_id: z.uuid() }).optional(),
  external_code: z.string().optional(),
});
function returnUrl(operation: string): string {
  const url = new URL(secret('PUBLIC_BASE_URL'));
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash)
    throw new Error('SERVER_CONFIGURATION_REQUIRED');
  url.searchParams.set('payment', operation);
  return url.toString();
}
export async function runProviderOperation(id: string, request?: Request): Promise<unknown> {
  const server = serverClient(request);
  const { data, error } = await server.rpc('claim_provider_operation', { p_operation: id });
  if (error)
    throw new Error(
      error.message === 'OPERATION_IN_PROGRESS'
        ? 'OPERATION_IN_PROGRESS'
        : 'PROVIDER_RECONCILIATION_REQUIRED',
    );
  const operation = operationSchema.parse(data);
  if (['COMPLETED', 'FAILED'].includes(operation.state)) return operation;
  if (
    !operation.venue_id ||
    !operation.kind ||
    !operation.method ||
    !operation.amount_cents ||
    !operation.currency ||
    !operation.lease_token
  )
    throw new Error('INVALID_PROVIDER_COMMAND');
  try {
    let providerId: string,
      state: string,
      amount: number,
      currency: string,
      checkout: string | null = null;
    if (operation.method === 'STRIPE') {
      if (operation.kind === 'PAYMENT') {
        const form = new URLSearchParams({
          mode: 'payment',
          success_url: returnUrl(id),
          cancel_url: returnUrl(id),
          client_reference_id: id,
          'metadata[operation_id]': id,
          'line_items[0][quantity]': '1',
          'line_items[0][price_data][currency]': 'eur',
          'line_items[0][price_data][unit_amount]': String(operation.amount_cents),
          'line_items[0][price_data][product_data][name]': 'Plateform · pagamento conto',
        });
        const session = checkoutSchema.parse(
          await stripe(
            operation.venue_id,
            operation.provider_id
              ? `checkout/sessions/${encodeURIComponent(operation.provider_id)}`
              : 'checkout/sessions',
            operation.provider_id ? undefined : form,
            operation.provider_id ? undefined : id,
          ),
        );
        if (
          session.metadata.operation_id !== id ||
          session.livemode !== (venueSecret('PAYMENTS_MODE', operation.venue_id) === 'live')
        )
          throw new Error('PROVIDER_VERIFICATION_FAILED');
        providerId = session.id;
        amount = session.amount_total;
        currency = session.currency.toUpperCase();
        checkout = session.url ?? null;
        state =
          session.payment_status === 'paid'
            ? 'COMPLETED'
            : session.status === 'expired'
              ? 'FAILED'
              : 'WAITING';
      } else {
        if (!operation.original_provider_id) throw new Error('INVALID_PROVIDER_REFUND');
        const original = checkoutSchema.parse(
          await stripe(
            operation.venue_id,
            `checkout/sessions/${encodeURIComponent(operation.original_provider_id)}`,
          ),
        );
        if (!original.payment_intent || original.payment_status !== 'paid')
          throw new Error('INVALID_PROVIDER_REFUND');
        const form = new URLSearchParams({
          payment_intent: original.payment_intent,
          amount: String(operation.amount_cents),
          'metadata[operation_id]': id,
        });
        const refund = refundSchema.parse(
          await stripe(
            operation.venue_id,
            operation.provider_id
              ? `refunds/${encodeURIComponent(operation.provider_id)}`
              : 'refunds',
            operation.provider_id ? undefined : form,
            operation.provider_id ? undefined : id,
          ),
        );
        if (refund.metadata.operation_id !== id) throw new Error('PROVIDER_VERIFICATION_FAILED');
        providerId = refund.id;
        amount = refund.amount;
        currency = refund.currency.toUpperCase();
        state =
          refund.status === 'succeeded'
            ? 'COMPLETED'
            : ['failed', 'canceled'].includes(refund.status)
              ? 'FAILED'
              : 'WAITING';
      }
    } else {
      const callback = new URL('/functions/v1/satispay-callback', secret('SUPABASE_URL'));
      callback.searchParams.set('operation', id);
      callback.searchParams.set(
        'token',
        await satispayCallbackToken(id, secret('SATISPAY_CALLBACK_TOKEN')),
      );
      const payload = {
        flow: operation.kind === 'PAYMENT' ? 'MATCH_CODE' : 'REFUND',
        amount_unit: operation.amount_cents,
        currency: 'EUR',
        external_code: id,
        metadata: { operation_id: id },
        callback_url: callback.toString(),
        ...(operation.kind === 'REFUND'
          ? { parent_payment_uid: operation.original_provider_id }
          : { redirect_url: returnUrl(id) }),
      };
      const payment = satispaySchema.parse(
        await satispay(
          operation.venue_id,
          operation.provider_id ? `/${encodeURIComponent(operation.provider_id)}` : '',
          operation.provider_id ? undefined : payload,
          operation.provider_id ? undefined : id,
        ),
      );
      if (payment.external_code !== id && payment.metadata?.operation_id !== id)
        throw new Error('PROVIDER_VERIFICATION_FAILED');
      providerId = payment.id;
      amount = payment.amount_unit;
      currency = payment.currency;
      state =
        payment.status === 'ACCEPTED'
          ? 'COMPLETED'
          : payment.status === 'CANCELED'
            ? 'FAILED'
            : 'WAITING';
      if (operation.kind === 'PAYMENT') {
        if (!payment.redirect_url) throw new Error('PROVIDER_VERIFICATION_FAILED');
        const mode = venueSecret('PAYMENTS_MODE', operation.venue_id);
        if (!isAllowedSatispayRedirect(payment.redirect_url, mode))
          throw new Error('PROVIDER_VERIFICATION_FAILED');
        checkout = payment.redirect_url;
      }
    }
    const { data: result, error: finishError } = await server.rpc('finish_provider_operation', {
      p_operation: id,
      p_lease: operation.lease_token,
      p_provider_id: providerId,
      p_state: state,
      p_amount: amount,
      p_currency: currency,
      p_event: `read:${providerId}:${state}`,
      p_checkout_url: checkout,
    });
    if (finishError) throw new Error('PROVIDER_VERIFICATION_FAILED');
    return result;
  } catch (error) {
    await server.rpc('release_provider_lease', { p_operation: id, p_lease: operation.lease_token });
    throw error;
  }
}
export async function reconcileStripeEvent(raw: string): Promise<unknown> {
  const event = z
    .object({
      id: z.string(),
      type: z.string(),
      data: z.object({
        object: z.object({
          id: z.string(),
          metadata: z.object({ operation_id: z.uuid().optional() }).passthrough().optional(),
        }),
      }),
    })
    .parse(JSON.parse(raw));
  if (
    ![
      'checkout.session.completed',
      'checkout.session.async_payment_succeeded',
      'checkout.session.async_payment_failed',
      'checkout.session.expired',
      'refund.updated',
      'refund.created',
      'refund.failed',
    ].includes(event.type)
  )
    return { received: true };
  if (!event.data.object.metadata?.operation_id) return { received: true };
  const server = serverClient();
  const { data, error } = await server
    .from('provider_operations')
    .select('id,provider_id,method,kind')
    .eq('id', event.data.object.metadata.operation_id)
    .single();
  if (
    error ||
    !data ||
    data.method !== 'STRIPE' ||
    (data.provider_id && data.provider_id !== event.data.object.id)
  )
    throw new Error('PROVIDER_VERIFICATION_FAILED');
  // Re-fetch the authoritative resource; webhook order and redirect URLs never determine the ledger.
  await runProviderOperation(data.id);
  return { received: true };
}

export async function stripeWebhookSecret(raw: string): Promise<string> {
  const event = z
    .object({
      data: z.object({
        object: z.object({
          metadata: z.object({ operation_id: z.uuid().optional() }).passthrough().optional(),
        }),
      }),
    })
    .parse(JSON.parse(raw));
  if (!event.data.object.metadata?.operation_id) return secret('STRIPE_WEBHOOK_SECRET');
  const { data, error } = await serverClient()
    .from('provider_operations')
    .select('venue_id,method')
    .eq('id', event.data.object.metadata.operation_id)
    .single();
  if (error || data?.method !== 'STRIPE') throw new Error('PROVIDER_VERIFICATION_FAILED');
  return venueSecret('STRIPE_WEBHOOK_SECRET', z.uuid().parse(data.venue_id));
}
