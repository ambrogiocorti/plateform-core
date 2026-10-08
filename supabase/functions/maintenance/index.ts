import { z } from 'npm:zod@4.6.5';
import { endpoint, rateLimit, serverClient, userClient } from '../_shared/http.ts';
async function validWorkerSecret(provided: string | null): Promise<boolean> {
  const expected = Deno.env.get('RETENTION_WORKER_SECRET');
  if (
    !expected ||
    !/^[0-9a-f]{64}$/.test(expected) ||
    !provided ||
    !/^[0-9a-f]{64}$/.test(provided)
  )
    return false;
  const a = new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(expected)),
    ),
    b = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(provided)));
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a[i]! ^ b[i]!;
  return difference === 0;
}
Deno.serve(
  endpoint(z.object({}).strict(), async (_body, request) => {
    const server = serverClient(request),
      worker = await validWorkerSecret(request.headers.get('x-worker-secret'));
    if (!worker) {
      const user = userClient(request, true),
        { data, error } = await user.auth.getUser();
      if (error || !data.user) throw new Error('UNAUTHORIZED');
      const { data: allowed, error: permission } = await user.rpc('authorize_health_probe');
      if (permission || allowed !== true) throw new Error('FORBIDDEN');
      await rateLimit(`retention:${data.user.id}`, 5, 600, request);
    } else await rateLimit('retention:worker', 30, 600, request);
    const { data: result, error } = await server.rpc('run_data_retention', { p_limit: 200 });
    if (error) throw new Error('REQUEST_FAILED');
    const state = z.object({ enabled: z.boolean() }).passthrough().parse(result);
    let completed = 0,
      failed = 0;
    if (state.enabled) {
      for (let n = 0; n < 20; n++) {
        const { data: claimed, error: claimError } = await server.rpc(
          'claim_customer_identity_cleanup',
        );
        if (claimError) throw new Error('REQUEST_FAILED');
        if (!claimed) break;
        const identity = z.object({ user_id: z.uuid(), lease_token: z.uuid() }).parse(claimed);
        let success = false;
        try {
          const { data, error: lookupError } = await server.auth.admin.getUserById(
            identity.user_id,
          );
          if (lookupError?.status === 404 || data.user?.deleted_at) success = true;
          else if (!lookupError && data.user?.app_metadata.kind === 'CUSTOMER_SESSION') {
            // Keep historical foreign keys. GoTrue pseudonymizes the technical identity and disables access.
            const { error: deleteError } = await server.auth.admin.deleteUser(
              identity.user_id,
              true,
            );
            success = !deleteError;
          }
        } catch {
          success = false;
        }
        const { error: finishError } = await server.rpc('finish_customer_identity_cleanup', {
          p_user: identity.user_id,
          p_lease: identity.lease_token,
          p_success: success,
        });
        if (finishError) throw new Error('REQUEST_FAILED');
        if (success) completed++;
        else failed++;
      }
    }
    return { ...state, identities_pseudonymized: completed, identities_failed: failed };
  }),
);
