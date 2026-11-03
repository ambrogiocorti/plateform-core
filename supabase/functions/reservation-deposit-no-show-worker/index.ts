// Scheduled worker: public.invoke_reservation_deposit_no_show_worker(10) (cron
// plateform-reservation-deposit-no-show-refunds, every minute) POSTs {"max_jobs":n} with the Vault
// token plateform_no_show_deposit_worker_token in x-plateform-worker-token. No JWT is sent, so
// config.toml needs verify_jwt = false; the token is the only authority and is checked first.
import { endpoint, rateLimit, serverClient } from '../_shared/http.ts';
import { satispayRefunds, stripeRefunds } from './provider-http.ts';
import { requestSchema, runWorker, validWorkerToken } from './worker.ts';

Deno.serve(
  endpoint(
    requestSchema,
    async (body, request) => {
      if (
        !(await validWorkerToken(
          request.headers.get('x-plateform-worker-token'),
          Deno.env.get('NO_SHOW_DEPOSIT_WORKER_TOKEN'),
        ))
      )
        throw new Error('UNAUTHORIZED');
      await rateLimit('reservation-deposit-no-show-worker', 12, 60, request);
      const server = serverClient(request);
      return await runWorker(
        {
          claim: (leaseSeconds) =>
            server.rpc('claim_reservation_deposit_no_show_action', {
              p_lease_seconds: leaseSeconds,
            }),
          finish: (args) => server.rpc('finish_reservation_deposit_no_show_action', args),
          releaseUnknown: (args) =>
            server.rpc('release_reservation_deposit_no_show_action_unknown', args),
          provider: (name) => (name === 'STRIPE' ? stripeRefunds : satispayRefunds),
          now: () => Date.now(),
        },
        body.max_jobs,
      );
    },
    { maxBytes: 1024 },
  ),
);
