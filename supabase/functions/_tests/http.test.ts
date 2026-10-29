import { z } from 'npm:zod@4.6.7';
import { endpoint, rateKey, serverClient } from '../_shared/http.ts';

Deno.test(
  'Edge handlers preserve a distinct correlation ID and normalize invalid input',
  async () => {
    const requestId = crypto.randomUUID(),
      correlationId = crypto.randomUUID();
    const handler = endpoint(z.object({}), async (_body, incoming) => ({
      request: incoming.headers.get('x-request-id'),
      correlation: incoming.headers.get('x-correlation-id'),
    }));
    const response = await handler(
      request('{}', { 'x-request-id': requestId, 'x-correlation-id': correlationId }),
    );
    const result = await response.json();
    assert(
      result.request === requestId && result.correlation === correlationId,
      'Distinct identifiers lost',
    );
    assert(
      response.headers.get('X-Correlation-Id') === correlationId,
      'Correlation missing from response',
    );
    const invalid = await handler(
      request('{}', { 'x-request-id': 'password-do-not-log', 'x-correlation-id': 'unsafe-value' }),
    );
    const normalized = await invalid.json();
    assert(
      /^[0-9a-f-]{36}$/.test(normalized.request) && normalized.request === normalized.correlation,
      'Invalid context not normalized',
    );
  },
);

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
function request(body: string, headers: Record<string, string> = {}) {
  return new Request('https://edge.test/action', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body,
  });
}

Deno.test(
  'server operations retain server credentials and forward only diagnostic context',
  async () => {
    const previousFetch = globalThis.fetch;
    const previousUrl = Deno.env.get('SUPABASE_URL');
    const previousKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    const requestId = crypto.randomUUID(),
      correlationId = crypto.randomUUID();
    Deno.env.set('SUPABASE_URL', 'https://backend.test');
    Deno.env.set('SUPABASE_SERVICE_ROLE_KEY', 'test-only-server-key');
    let captured: Headers | undefined;
    globalThis.fetch = (_input, options) => {
      captured = new Headers(options?.headers);
      return Promise.resolve(
        new Response('true', { headers: { 'content-type': 'application/json' } }),
      );
    };
    try {
      const server = serverClient(
        request('{}', {
          authorization: 'Bearer forged-caller-token',
          apikey: 'forged-caller-key',
          cookie: 'private-cookie',
          'x-forwarded-for': '203.0.113.99',
          'x-request-id': requestId,
          'x-correlation-id': correlationId,
        }),
      );
      const result = await server.rpc('consume_edge_rate_limit', {
        p_bucket: 'test',
        p_limit: 2,
        p_seconds: 60,
      });
      assert(!result.error && result.data === true, 'Server call failed');
      assert(
        captured?.get('authorization') === 'Bearer test-only-server-key',
        'Caller replaced server authorization',
      );
      assert(captured?.get('apikey') === 'test-only-server-key', 'Caller replaced server API key');
      assert(
        !captured?.has('cookie') && !captured?.has('x-forwarded-for'),
        'Unnecessary private headers forwarded',
      );
      assert(
        captured?.get('x-request-id') === requestId &&
          captured?.get('x-correlation-id') === correlationId,
        'Diagnostic context lost',
      );
    } finally {
      globalThis.fetch = previousFetch;
      if (previousUrl === undefined) Deno.env.delete('SUPABASE_URL');
      else Deno.env.set('SUPABASE_URL', previousUrl);
      if (previousKey === undefined) Deno.env.delete('SUPABASE_SERVICE_ROLE_KEY');
      else Deno.env.set('SUPABASE_SERVICE_ROLE_KEY', previousKey);
    }
  },
);
const handler = endpoint(z.object({ value: z.string() }).strict(), async (body, request) => ({
  value: body.value,
  correlation: request.headers.get('x-request-id'),
}));

Deno.test('CORS accepts only the configured origin and exposes a correlation ID', async () => {
  Deno.env.set('ALLOWED_ORIGINS', 'https://staff.test,https://public.test');
  const denied = await handler(
    request('{"value":"ok"}', { origin: 'https://staff.test.attacker.invalid' }),
  );
  assert(
    denied.status === 403 && !denied.headers.has('Access-Control-Allow-Origin'),
    'Untrusted origin accepted',
  );
  const id = crypto.randomUUID();
  const accepted = await handler(
    request('{"value":"ok"}', { origin: 'https://staff.test', 'x-request-id': id }),
  );
  const body = await accepted.json();
  assert(
    accepted.status === 200 &&
      accepted.headers.get('Access-Control-Allow-Origin') === 'https://staff.test',
    'Configured origin rejected',
  );
  assert(
    body.correlation === id && accepted.headers.get('X-Request-Id') === id,
    'Correlation was lost',
  );
  assert(accepted.headers.get('Cache-Control') === 'no-store', 'Response is cacheable');
});
Deno.test(
  'invalid JSON, media type, schema and methods fail before executing the handler',
  async () => {
    assert(
      (await handler(request('{bad'))).status === 400,
      'Malformed JSON was not rejected as client error',
    );
    assert(
      (await handler(request('{"value":"ok"}', { 'content-type': 'application/json-evil' })))
        .status === 400,
      'Wrong media type accepted',
    );
    assert(
      (await handler(request('{"value":"ok","role":"SUPER_ADMIN"}'))).status === 400,
      'Unknown schema property accepted',
    );
    assert((await handler(new Request('https://edge.test/action'))).status === 405, 'GET accepted');
  },
);
Deno.test('body limit applies to streamed bytes even without a Content-Length header', async () => {
  const oversized = request(JSON.stringify({ value: 'é'.repeat(20000) }));
  assert(!oversized.headers.has('content-length'), 'Fixture unexpectedly sets a length');
  const response = await handler(oversized);
  assert(
    response.status === 400 && (await response.json()).code === 'PAYLOAD_TOO_LARGE',
    'Byte limit not enforced',
  );
});
Deno.test(
  'unexpected errors never expose credentials or private error text in logs and response',
  async () => {
    const logs: string[] = [];
    const previous = console.error;
    console.error = (value: unknown) => logs.push(String(value));
    try {
      const failure = endpoint(z.object({ password: z.string() }), async (body) => {
        throw new Error(`Database failed for password ${body.password}`);
      });
      const response = await failure(request('{"password":"secret-password-123"}'));
      const body = await response.text();
      assert(
        response.status === 500 && !body.includes('secret-password-123'),
        'Secret exposed in HTTP response',
      );
      assert(
        logs.length === 1 &&
          !logs[0]!.includes('secret-password-123') &&
          !logs[0]!.includes('Database failed'),
        'Secret exposed in logs',
      );
    } finally {
      console.error = previous;
    }
  },
);
Deno.test(
  'rate limit identity is a keyed digest and requires a gateway client address',
  async () => {
    Deno.env.set('RATE_LIMIT_SECRET', 'test-only-rate-secret-with-enough-entropy');
    Deno.env.set('TRUSTED_CLIENT_IP_HEADER', 'cf-connecting-ip');
    const first = await rateKey(
      request('{}', {
        'cf-connecting-ip': '203.0.113.7',
        'x-forwarded-for': 'forged, 198.51.100.8',
      }),
    );
    const second = await rateKey(
      request('{}', {
        'cf-connecting-ip': '203.0.113.7',
        'x-forwarded-for': 'other-forged, 198.51.100.9',
      }),
    );
    assert(
      first === second && /^[0-9a-f]{64}$/.test(first),
      'Rate key leaks IP or trusts a client-controlled forwarding chain',
    );
    let rejected = false;
    try {
      await rateKey(request('{}', { 'x-forwarded-for': '203.0.113.7' }));
    } catch {
      rejected = true;
    }
    assert(rejected, 'Missing gateway address accepted');
    for (const value of ['forged', '203.0.113.7, 198.51.100.8', 'unknown', '[2001:db8::1]']) {
      let invalidRejected = false;
      try {
        await rateKey(request('{}', { 'cf-connecting-ip': value }));
      } catch {
        invalidRejected = true;
      }
      assert(invalidRejected, 'Invalid or multi-address gateway value accepted');
    }
    const ipv6 = await rateKey(request('{}', { 'cf-connecting-ip': '2001:db8::1' }));
    const equivalent = await rateKey(
      request('{}', { 'cf-connecting-ip': '2001:0db8:0000:0000:0000:0000:0000:0001' }),
    );
    assert(ipv6 === equivalent && ipv6 !== first, 'IP identities not normalized or isolated');
  },
);
