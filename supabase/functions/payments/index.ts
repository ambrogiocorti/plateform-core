import { z } from 'npm:zod@4.6.5';
import { endpoint, rateLimit, userClient } from '../_shared/http.ts';
import { runProviderOperation } from '../_shared/providers.ts';
Deno.serve(
  endpoint(
    z.object({ payment_id: z.uuid(), refund_id: z.uuid().nullable().default(null) }).strict(),
    async (body, request) => {
      const user = userClient(request);
      const { data: identity, error } = await user.auth.getUser();
      if (error || !identity.user) throw new Error('UNAUTHORIZED');
      // No external call happens without a licensed provider: prepare_provider_operation runs
      // the provider_operations licence guard (PAYMENT_METHOD_UNLICENSED) before any HTTP request.
      await rateLimit(`payments:${identity.user.id}`, 30, 60, request);
      const { data: operation, error: prepareError } = await user.rpc(
        'prepare_provider_operation',
        { p_payment: body.payment_id, p_refund: body.refund_id },
      );
      if (prepareError) {
        const safeCodes = new Set([
          'FORBIDDEN',
          'REGISTER_FORBIDDEN',
          'PAYMENT_METHOD_UNLICENSED',
          'PAYMENT_NOT_PENDING',
          'INVALID_PROVIDER_METHOD',
          'INVALID_PROVIDER_REFUND',
        ]);
        throw new Error(safeCodes.has(prepareError.message) ? prepareError.message : 'FORBIDDEN');
      }
      const prepared = z
        .object({ id: z.uuid(), state: z.string(), checkout_url: z.string().nullable() })
        .parse(operation);
      if (['COMPLETED', 'FAILED'].includes(prepared.state)) return prepared;
      return await runProviderOperation(prepared.id, request);
    },
  ),
);
