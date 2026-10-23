// Scheduled dispatch: private.dispatch_continuity_retention_worker() (20261019090000) POSTs
// {"source":"cron","worker":"RETENTION"} with the anon JWT and the runtime worker token in
// x-plateform-worker-token. The anon JWT carries no authority, so config.toml uses
// verify_jwt = false (like maintenance); the worker token, verified by the database, is checked
// before anything else. Physical purge stays with tools/backup-retention-worker: see logic.ts.
import { endpoint, rateLimit, serverClient } from '../_shared/http.ts';
import { authorize, requestSchema, runDispatch } from './logic.ts';

Deno.serve(
  endpoint(
    requestSchema,
    async (_body, request) => {
      const server = serverClient(request);
      const deps = {
        verifyToken: async (token: string) =>
          await server.rpc('verify_continuity_worker_token', { p_token: token }),
        reconcile: async () => await server.rpc('reconcile_all_continuity_alerts'),
        listBacklog: async (nowIso: string, limit: number) =>
          await server
            .from('backup_metadata')
            .select('id,retention_until,purge_attempts,purge_error_code,purge_lease_expires_at', {
              count: 'exact',
            })
            .eq('status', 'SUCCEEDED')
            .is('artifacts_purged_at', null)
            .lte('retention_until', nowIso)
            .order('retention_until', { ascending: true })
            .order('id', { ascending: true })
            .limit(limit),
        now: () => Date.now(),
      };
      await authorize(deps, request.headers.get('x-plateform-worker-token'));
      await rateLimit('continuity-retention-worker', 12, 600, request);
      return await runDispatch(deps);
    },
    { maxBytes: 1024 },
  ),
);
