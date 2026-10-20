// Daily independent recovery test of the audit archive (cron `plateform-audit-archive-recovery-verify`,
// 03:17). Downloads the latest batches from the primary and replica stores, decrypts them, recomputes
// every hash and the chain, and records PASS/FAIL with `record_audit_archive_verification`.
import { z } from 'npm:zod@4.6.5';
import { endpoint, serverClient } from '../_shared/http.ts';
import {
  checkpointSchema,
  loadKeyring,
  verifyArchive,
  type ArchiveStore,
  type VerificationResult,
} from '../audit-archive-worker/archive.ts';
import { archiveStores, authorizeWorker, rpc } from '../audit-archive-worker/runtime.ts';

const statusSchema = z
  .object({
    last_batch: z.number().int().min(0),
    chain_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .passthrough();

Deno.serve(
  endpoint(z.object({}).strict(), async (_body, request) => {
    const server = serverClient(request);
    await authorizeWorker(request, server);
    const failed = (failure: string): VerificationResult => ({
      pass: false,
      batches: 0,
      rows: 0,
      chain: null,
      failure,
    });
    let result: VerificationResult, stores: ArchiveStore[] | null;
    const keyring = await loadKeyring((name) => Deno.env.get(name)).catch(() => null);
    try {
      stores = archiveStores(server, false);
    } catch {
      stores = null;
    }
    if (!keyring) result = failed('ARCHIVE_KEY_INVALID');
    else if (!stores) result = failed('ARCHIVE_STORAGE_NOT_CONFIGURED');
    else
      result = await verifyArchive({
        status: async () => statusSchema.parse(await rpc(server, 'audit_archive_status')),
        checkpoints: async (after, limit) =>
          z.array(checkpointSchema).parse(
            await rpc(server, 'list_audit_archive_checkpoints', {
              p_after: after,
              p_limit: limit,
            }),
          ),
        stores,
        keys: keyring.keys,
      });
    await rpc(server, 'record_audit_archive_verification', {
      p_pass: result.pass,
      p_batches: result.batches,
      p_rows: result.rows,
      p_chain: result.chain,
      p_failure_code: result.failure,
    });
    return {
      result: result.pass ? 'PASS' : 'FAIL',
      checked_batches: result.batches,
      checked_rows: result.rows,
      final_chain_sha256: result.chain,
      failure_code: result.failure,
    };
  }),
);
