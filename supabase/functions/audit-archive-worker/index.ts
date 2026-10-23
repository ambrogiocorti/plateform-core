// Automatic audit-log archive rotation (cron `plateform-audit-archive-encrypted`, every 15 minutes).
// Body from the database: {"max_batches":5}. Audit rows are only read, never modified or deleted.
import { z } from 'npm:zod@4.6.5';
import { endpoint, serverClient } from '../_shared/http.ts';
import { loadKeyring, rotateArchive, type FinishArgs } from './archive.ts';
import { archiveStores, authorizeWorker, rpc } from './runtime.ts';

// pg_net waits 90 s; stop claiming new batches well before that.
const TIME_BUDGET_MS = 55_000;

Deno.serve(
  endpoint(
    z.object({ max_batches: z.number().int().min(1).max(20).default(5) }).strict(),
    async (body, request) => {
      const started = Date.now(),
        server = serverClient(request);
      await authorizeWorker(request, server);
      const { current } = await loadKeyring((name) => Deno.env.get(name)).catch(() => {
        throw new Error('SERVER_CONFIGURATION_REQUIRED');
      });
      if (!current) throw new Error('SERVER_CONFIGURATION_REQUIRED');
      const result = await rotateArchive({
        claim: () => rpc(server, 'claim_audit_archive_batch'),
        read: (lease, limit) =>
          rpc(server, 'read_audit_archive_batch', { p_lease: lease, p_limit: limit }),
        finish: (args: FinishArgs) => rpc(server, 'finish_audit_archive_batch', args),
        release: async (lease) => {
          await rpc(server, 'release_empty_audit_archive', { p_lease: lease });
        },
        stores: archiveStores(server, true),
        key: current,
        maxBatches: body.max_batches,
        deadline: started + TIME_BUDGET_MS,
        now: () => Date.now(),
      });
      return { status: 'OK', ...result };
    },
  ),
);
