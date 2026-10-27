import { createClient } from 'npm:@supabase/supabase-js@2.116.0';
import { z } from 'npm:zod@4.6.5';
import { requestContext } from '../../../shared/request-context.ts';

export function secret(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error('SERVER_CONFIGURATION_REQUIRED');
  return value;
}

export function serverClient(request?: Request) {
  const { requestId, correlationId } = requestContext(request?.headers ?? new Headers());
  return createClient(secret('SUPABASE_URL'), secret('SUPABASE_SERVICE_ROLE_KEY'), {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      fetch: (input, options) =>
        fetch(input, {
          ...options,
          signal: options?.signal
            ? AbortSignal.any([options.signal, AbortSignal.timeout(15000)])
            : AbortSignal.timeout(15000),
        }),
      // Never forward caller credentials or API keys into a privileged server client.
      headers: { 'x-request-id': requestId, 'x-correlation-id': correlationId },
    },
  });
}

export function userClient(request: Request, asRealUser = false) {
  const authorization = request.headers.get('authorization');
  if (!authorization?.startsWith('Bearer ')) throw new Error('UNAUTHORIZED');
  return createClient(secret('SUPABASE_URL'), secret('SUPABASE_ANON_KEY'), {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      fetch: (input, options) =>
        fetch(input, {
          ...options,
          signal: options?.signal
            ? AbortSignal.any([options.signal, AbortSignal.timeout(15000)])
            : AbortSignal.timeout(15000),
        }),
      headers: {
        Authorization: authorization,
        ...(!asRealUser && request.headers.has('x-plateform-impersonation')
          ? { 'x-plateform-impersonation': request.headers.get('x-plateform-impersonation')! }
          : {}),
        'x-request-id': request.headers.get('x-request-id') ?? crypto.randomUUID(),
        'x-correlation-id':
          request.headers.get('x-correlation-id') ??
          request.headers.get('x-request-id') ??
          crypto.randomUUID(),
      },
    },
  });
}

export async function rateKey(request: Request): Promise<string> {
  // Explicit deployment contract: this header must be written by the trusted gateway.
  // Supabase's hosted Cloudflare path uses CF-Connecting-IP; never infer trust from XFF.
  const header = secret('TRUSTED_CLIENT_IP_HEADER');
  if (!['cf-connecting-ip', 'x-forwarded-for'].includes(header))
    throw new Error('SERVER_CONFIGURATION_REQUIRED');
  const address = request.headers.get(header)?.trim();
  const ip = header === 'x-forwarded-for' ? address?.split(',').at(-1)?.trim() : address;
  const family = z.ipv4().safeParse(ip).success ? 4 : z.ipv6().safeParse(ip).success ? 6 : 0;
  if (!ip || !family) throw new Error('CLIENT_ADDRESS_UNAVAILABLE');
  const canonical = family === 6 ? new URL(`http://[${ip}]/`).hostname : ip;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret('RATE_LIMIT_SECRET')),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(canonical));
  return Array.from(new Uint8Array(signature), (value) => value.toString(16).padStart(2, '0')).join(
    '',
  );
}

export async function rateLimit(
  bucket: string,
  limit: number,
  seconds: number,
  request?: Request,
): Promise<void> {
  const { data, error } = await serverClient(request).rpc('consume_edge_rate_limit', {
    p_bucket: bucket,
    p_limit: limit,
    p_seconds: seconds,
  });
  if (error || data !== true) throw new Error('RATE_LIMITED');
}

async function readJson(request: Request, maxBytes = 32768): Promise<unknown> {
  const length = request.headers.get('content-length');
  if (length && Number(length) > maxBytes) throw new Error('PAYLOAD_TOO_LARGE');
  if (!request.body) throw new Error('INVALID_PAYLOAD');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      size += result.value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new Error('PAYLOAD_TOO_LARGE');
      }
      chunks.push(result.value);
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
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new Error('INVALID_PAYLOAD');
  }
}

async function recordTelemetry(
  event: string,
  requestId: string,
  operation: string,
  duration: number,
  code: string,
  status: number,
  correlationId = requestId,
): Promise<void> {
  if (Deno.env.get('TELEMETRY_ENABLED') !== 'true') return;
  try {
    const server = createClient(secret('SUPABASE_URL'), secret('SUPABASE_SERVICE_ROLE_KEY'), {
      auth: { persistSession: false, autoRefreshToken: false },
      global: {
        headers: { 'x-request-id': requestId, 'x-correlation-id': correlationId },
        fetch: (input, options) => fetch(input, { ...options, signal: AbortSignal.timeout(1000) }),
      },
    });
    const { error } = await server.rpc('ingest_edge_telemetry', {
      p_event: event,
      p_environment: Deno.env.get('ENVIRONMENT') ?? 'development',
      p_release: Deno.env.get('RELEASE_VERSION') ?? '0.1.0',
      p_operation: operation,
      p_duration: Math.min(60000, Math.round(duration)),
      p_code: code,
      p_status: status,
      p_request: requestId,
    });
    if (error) throw new Error('TELEMETRY_UNAVAILABLE');
  } catch {
    console.error(
      JSON.stringify({
        level: 'error',
        request_id: requestId,
        correlation_id: correlationId,
        error_code: 'TELEMETRY_UNAVAILABLE',
      }),
    );
  }
}

export function endpoint<T>(
  schema: z.ZodType<T>,
  handler: (body: T, request: Request) => Promise<unknown>,
  options: { maxBytes?: number } = {},
) {
  return async (request: Request): Promise<Response> => {
    const { requestId, correlationId } = requestContext(request.headers);
    const origin = request.headers.get('origin');
    const allowedOrigins = (Deno.env.get('ALLOWED_ORIGINS') ?? '')
      .split(',')
      .map((value) => value.trim());
    const headers = new Headers({
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'X-Request-Id': requestId,
      'X-Correlation-Id': correlationId,
      Vary: 'Origin',
    });
    if (origin && allowedOrigins.includes(origin)) {
      headers.set('Access-Control-Allow-Origin', origin);
      headers.set(
        'Access-Control-Allow-Headers',
        'authorization,apikey,content-type,x-client-info,x-request-id,x-correlation-id,x-plateform-impersonation',
      );
      headers.set('Access-Control-Allow-Methods', 'POST,OPTIONS');
      headers.set('Access-Control-Expose-Headers', 'X-Request-Id,X-Correlation-Id');
    }
    if (origin && !allowedOrigins.includes(origin))
      return new Response(JSON.stringify({ code: 'ORIGIN_FORBIDDEN', request_id: requestId }), {
        status: 403,
        headers,
      });
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    if (request.method !== 'POST')
      return new Response(JSON.stringify({ code: 'METHOD_NOT_ALLOWED', request_id: requestId }), {
        status: 405,
        headers,
      });
    const started = performance.now();
    try {
      if (
        request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !==
        'application/json'
      )
        throw new Error('INVALID_PAYLOAD');
      const body = schema.parse(await readJson(request, options.maxBytes));
      const requestHeaders = new Headers(request.headers);
      requestHeaders.set('x-request-id', requestId);
      requestHeaders.set('x-correlation-id', correlationId);
      const result = await handler(
        body,
        new Request(request.url, { method: request.method, headers: requestHeaders }),
      );
      console.log(
        JSON.stringify({
          level: 'info',
          request_id: requestId,
          correlation_id: correlationId,
          timestamp: new Date().toISOString(),
          environment: Deno.env.get('ENVIRONMENT') ?? 'development',
          release_version: Deno.env.get('RELEASE_VERSION') ?? '0.1.0',
          operation: new URL(request.url).pathname,
          result: 'SUCCESS',
          latency_ms: Math.round(performance.now() - started),
        }),
      );
      await recordTelemetry(
        'HTTP_SUCCESS',
        requestId,
        new URL(request.url).pathname.split('/').at(-1) ?? 'unknown',
        performance.now() - started,
        'OK',
        200,
        correlationId,
      );
      return new Response(JSON.stringify(result), { headers });
    } catch (error) {
      const rawCode = error instanceof Error ? error.message : '';
      const allowed = [
        'RATE_LIMITED',
        'UNAUTHORIZED',
        'FORBIDDEN',
        'INVALID_PAYLOAD',
        'PAYLOAD_TOO_LARGE',
        'RESERVATIONS_DISABLED',
        'BOOKING_CAPACITY_REACHED',
        'BOOKING_CLOSED',
        'BOOKING_SLOT_UNAVAILABLE',
        'BOOKING_DATE_UNAVAILABLE',
        'BOOKING_IN_PAST',
        'WAITLIST_DISABLED',
        'INVALID_WAITLIST_REQUEST',
        'WAITLIST_DATE_UNAVAILABLE',
        'WAITLIST_TIME_UNAVAILABLE',
        'WAITLIST_IN_PAST',
        'WAITLIST_ACCESS_DENIED',
        'INVALID_WAITLIST_ACCEPTANCE',
        'WAITLIST_NOT_OFFERED',
        'WAITLIST_OFFER_EXPIRED',
        'WAITLIST_CAPACITY_LOST',
        'BOOKING_DEPOSITS_DISABLED',
        'VENUE_UNAVAILABLE',
        'FORM_REQUIRED_FIELDS',
        'INVALID_FORM_OPTION',
        'INVALID_BOOKING_DETAILS',
        'CONTACT_RESTAURANT_FOR_LARGE_PARTY',
        'IDEMPOTENCY_MISMATCH',
        'INVALID_ASSET',
        'ASSET_RECOVERY_REQUIRED',
        'STORAGE_LIMIT',
        'CHAIN_SCOPE_REQUIRED',
        'STAFF_MANAGEMENT_FORBIDDEN',
        'STAFF_IDENTIFIER_TAKEN',
        'STAFF_COMMAND_PENDING',
        'STAFF_ALREADY_ACTIVE',
        'STAFF_DISABLED',
        'INVALID_STAFF_COMMAND',
        'STAFF_LIMIT',
        'SCOPE_ESCALATION',
        'VENUE_FORBIDDEN',
        'VENUE_ASSIGNMENT_REQUIRED',
        'STEP_UP_REQUIRED',
        'OPERATION_IN_PROGRESS',
        'IDENTITY_VERIFICATION_REQUIRED',
        'PASSWORD_REQUIRED_FOR_RECOVERY',
        'STAFF_COMMAND_RECOVERY_REQUIRED',
        'SERVICE_UNAVAILABLE',
        'BOOKING_DUPLICATE',
        'INVALID_FORM_ANSWERS',
        'INVALID_FORM_NUMBER',
        'INVALID_FORM_CHECKBOX',
        'INVALID_FORM_TEXT',
        'UNKNOWN_FORM_FIELD',
        'NONEXISTENT_LOCAL_TIME',
        'INVALID_REQUEST',
        'PAYMENT_METHOD_UNLICENSED',
        'PAYMENT_NOT_PENDING',
        'INVALID_PROVIDER_METHOD',
        'INVALID_PROVIDER_REFUND',
        'PROVIDER_RECONCILIATION_REQUIRED',
        'PROVIDER_REQUEST_FAILED',
      ];
      const code = allowed.includes(rawCode)
        ? rawCode
        : error instanceof z.ZodError
          ? 'INVALID_PAYLOAD'
          : 'REQUEST_FAILED';
      console.error(
        JSON.stringify({
          level: 'error',
          request_id: requestId,
          correlation_id: correlationId,
          timestamp: new Date().toISOString(),
          environment: Deno.env.get('ENVIRONMENT') ?? 'development',
          release_version: Deno.env.get('RELEASE_VERSION') ?? '0.1.0',
          operation: new URL(request.url).pathname,
          result: 'FAILURE',
          error_code: code,
          latency_ms: Math.round(performance.now() - started),
        }),
      );
      const status =
        code === 'RATE_LIMITED'
          ? 429
          : code === 'UNAUTHORIZED'
            ? 401
            : [
                  'FORBIDDEN',
                  'WAITLIST_ACCESS_DENIED',
                  'STAFF_MANAGEMENT_FORBIDDEN',
                  'SCOPE_ESCALATION',
                  'VENUE_FORBIDDEN',
                  'PAYMENT_METHOD_UNLICENSED',
                ].includes(code)
              ? 403
              : [
                    'IDEMPOTENCY_MISMATCH',
                    'STAFF_COMMAND_PENDING',
                    'STAFF_ALREADY_ACTIVE',
                    'STAFF_IDENTIFIER_TAKEN',
                    'OPERATION_IN_PROGRESS',
                    'BOOKING_DUPLICATE',
                    'PAYMENT_NOT_PENDING',
                    'INVALID_PROVIDER_REFUND',
                    'PROVIDER_RECONCILIATION_REQUIRED',
                    'WAITLIST_NOT_OFFERED',
                    'WAITLIST_CAPACITY_LOST',
                    'WAITLIST_OFFER_EXPIRED',
                  ].includes(code)
                ? 409
                : [
                      'REQUEST_FAILED',
                      'ASSET_RECOVERY_REQUIRED',
                      'STAFF_COMMAND_RECOVERY_REQUIRED',
                    ].includes(code)
                  ? 500
                  : code === 'PROVIDER_REQUEST_FAILED'
                    ? 503
                    : 400;
      await recordTelemetry(
        'HTTP_FAILURE',
        requestId,
        new URL(request.url).pathname.split('/').at(-1) ?? 'unknown',
        performance.now() - started,
        code,
        status,
        correlationId,
      );
      return new Response(
        JSON.stringify({
          code,
          human_message:
            'La richiesta non è stata completata. Verifica i dati o contatta il ristorante.',
          request_id: requestId,
        }),
        { status, headers },
      );
    }
  };
}
