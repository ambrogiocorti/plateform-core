import { z } from 'npm:zod@4.6.7';
import { secret, serverClient, rateLimit } from '../_shared/http.ts';
import { runProviderOperation, satispayCallbackToken } from '../_shared/providers.ts';
async function sameSecret(value: string, expected: string): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(expected),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(expected));
  return await crypto.subtle.verify('HMAC', key, signature, new TextEncoder().encode(value));
}
Deno.serve(async (request) => {
  if (request.method !== 'GET') return new Response(null, { status: 405 });
  try {
    const url = new URL(request.url),
      operation = z.uuid().parse(url.searchParams.get('operation'));
    const expectedToken = await satispayCallbackToken(operation, secret('SATISPAY_CALLBACK_TOKEN'));
    if (!(await sameSecret(url.searchParams.get('token') ?? '', expectedToken)))
      return new Response(null, { status: 401 });
    await rateLimit(`satispay-callback:${operation}`, 20, 60, request);
    const { data, error } = await serverClient(request)
      .from('provider_operations')
      .select('method')
      .eq('id', operation)
      .single();
    if (error || data?.method !== 'SATISPAY_API') return new Response(null, { status: 404 });
    await runProviderOperation(operation, request);
    return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return new Response(null, { status: 503 });
  }
});
