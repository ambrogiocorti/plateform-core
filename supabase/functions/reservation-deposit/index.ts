// Guest checkout for a large-group booking deposit (owner decision 2026-10-21). No Supabase session:
// the 64-hex access token returned once by create_public_reservation is the guest's only authority,
// checked by the database (hash, deposit, expiry). begin_reservation_deposit runs the licence and
// provider gate (BOOKING_DEPOSITS + a licensed provider the venue offers) before any provider call.
// The browser never confirms a payment: COMPLETED comes from an authoritative provider read here,
// in stripe-webhook or in satispay-callback.
import { endpoint, rateKey, rateLimit, serverClient } from '../_shared/http.ts';
import { depositStatus, requestSchema, startCheckout } from '../_shared/deposits.ts';
import { depositGateway } from '../_shared/deposit-providers.ts';

Deno.serve(
  endpoint(
    requestSchema,
    async (body, request) => {
      const addressKey = await rateKey(request);
      await rateLimit(`reservation-deposit-ip:${addressKey}`, 30, 600, request);
      await rateLimit(`reservation-deposit:${body.deposit_id}`, 20, 600, request);
      const server = serverClient(request);
      const deps = {
        rpc: (name: string, args: Record<string, unknown>) => server.rpc(name, args),
        gateway: depositGateway,
      };
      return body.action === 'status'
        ? await depositStatus(deps, body)
        : await startCheckout(deps, body);
    },
    { maxBytes: 2048 },
  ),
);
