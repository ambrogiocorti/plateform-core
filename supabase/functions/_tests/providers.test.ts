import {
  isAllowedSatispayRedirect,
  satispayCallbackToken,
  satispayHeaders,
  verifyStripeSignature,
} from '../_shared/providers.ts';
function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
async function stripeHeader(raw: string, timestamp: number) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode('whsec_test'),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = new Uint8Array(
    await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${timestamp}.${raw}`)),
  );
  return `t=${timestamp},v1=${Array.from(sig, (x) => x.toString(16).padStart(2, '0')).join('')}`;
}
Deno.test('Stripe verifies exact bytes, timestamp and rotated v1 signatures', async () => {
  const raw = '{"payment":"test"}',
    time = 1800000000;
  const header = await stripeHeader(raw, time);
  assert(
    await verifyStripeSignature(raw, header, 'whsec_test', time * 1000),
    'Valid signature rejected',
  );
  assert(
    !(await verifyStripeSignature(raw + ' ', header, 'whsec_test', time * 1000)),
    'Body alteration accepted',
  );
  assert(
    !(await verifyStripeSignature(raw, header, 'whsec_test', (time + 301) * 1000)),
    'Expired signature accepted',
  );
  assert(
    !(await verifyStripeSignature(raw, `t=${time},${header}`, 'whsec_test', time * 1000)),
    'Multiple timestamps accepted',
  );
  assert(
    await verifyStripeSignature(raw, `v1=${'0'.repeat(64)},${header}`, 'whsec_test', time * 1000),
    'Rotated signature rejected',
  );
});
Deno.test('Satispay signs the exact request target, host, date and body digest', async () => {
  const pair = await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 4096,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  );
  const pem = `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey))))}\n-----END PRIVATE KEY-----`;
  const url = new URL('https://staging.authservices.satispay.com/g_business/v1/payments?a=1'),
    body = '{"amount_unit":1200}',
    date = 'Mon, 05 Oct 2026 10:00:00 GMT';
  const headers = await satispayHeaders('POST', url, body, 'fixture_key', pem, date);
  const signed = `(request-target): post ${url.pathname}${url.search}\nhost: ${url.host}\ndate: ${date}\ndigest: ${headers.get('Digest')}`;
  const sig = headers.get('Authorization')!.match(/signature="([^"]+)"/)![1]!;
  assert(
    await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5',
      pair.publicKey,
      Uint8Array.from(atob(sig), (c) => c.charCodeAt(0)),
      new TextEncoder().encode(signed),
    ),
    'RSA signature invalid',
  );
  assert(
    headers.get('Digest') ===
      `SHA-256=${btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body)))))}`,
    'Digest mismatch',
  );
});

Deno.test('Satispay callback token is operation-scoped and deterministic', async () => {
  const secret = 'x'.repeat(64);
  const first = await satispayCallbackToken('11111111-1111-4111-8111-111111111111', secret);
  const retry = await satispayCallbackToken('11111111-1111-4111-8111-111111111111', secret);
  const other = await satispayCallbackToken('22222222-2222-4222-8222-222222222222', secret);
  assert(first === retry, 'Callback token is not deterministic');
  assert(first !== other, 'Callback token is not scoped to the operation');
  assert(!first.includes(secret), 'Callback token leaks the callback secret');
});

Deno.test('Satispay redirect allowlist is fail-closed', () => {
  assert(
    isAllowedSatispayRedirect('https://staging-online.satispay.com/pay/abc', 'test'),
    'Legacy sandbox redirect host rejected',
  );
  assert(
    isAllowedSatispayRedirect('https://staging.online.satispay.com/pay/abc', 'test'),
    'Current sandbox redirect host rejected',
  );
  assert(
    isAllowedSatispayRedirect('https://online.satispay.com/pay/abc', 'live'),
    'Production redirect host rejected',
  );
  assert(
    !isAllowedSatispayRedirect('https://staging.online.satispay.com.evil.example/pay/abc', 'test'),
    'Lookalike hostname accepted',
  );
  assert(
    !isAllowedSatispayRedirect('http://staging.online.satispay.com/pay/abc', 'test'),
    'Non-HTTPS redirect accepted',
  );
  assert(
    !isAllowedSatispayRedirect('https://user:pass@staging.online.satispay.com/pay/abc', 'test'),
    'Credential-bearing redirect accepted',
  );
});
