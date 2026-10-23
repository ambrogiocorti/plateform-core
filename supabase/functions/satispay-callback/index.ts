import { z } from 'npm:zod@4.6.5';
import { secret, serverClient, rateLimit } from '../_shared/http.ts';
import {
  runProviderOperation,
  satispayCallbackToken,
  satispayDepositCallbackToken,
} from '../_shared/providers.ts';
import { reconcileDeposit } from '../_shared/deposits.ts';
import { depositGateway } from '../_shared/deposit-providers.ts';
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
    const url = new URL(request.url);
    if (url.searchParams.has('deposit')) {
      // Booking deposit: the callback only says "look again"; the Satispay read decides.
      const deposit = z.uuid().parse(url.searchParams.get('deposit'));
      const expected = await satispayDepositCallbackToken(
        deposit,
        secret('SATISPAY_CALLBACK_TOKEN'),
      );
      if (!(await sameSecret(url.searchParams.get('token') ?? '', expected)))
        return new Response(null, { status: 401 });
      await rateLimit(`satispay-deposit-callback:${deposit}`, 20, 60, request);
      const server = serverClient(request);
      await reconcileDeposit(
        { rpc: (name, args) => server.rpc(name, args), gateway: depositGateway },
        deposit,
        'SATISPAY',
      );
      return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
    }
    const operation = z.uuid().parse(url.searchParams.get('operation'));
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
