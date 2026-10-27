import { z } from 'npm:zod@4.6.7';
import { endpoint, rateLimit, serverClient, userClient } from '../_shared/http.ts';
type Probe = { component: string; status: string; latency: number | null; code: string };
Deno.serve(
  endpoint(z.object({}).strict(), async (_body, request) => {
    const user = userClient(request),
      server = serverClient(request);
    const { data: identity, error } = await user.auth.getUser();
    if (error || !identity.user) throw new Error('UNAUTHORIZED');
    const { data: allowed, error: authorizeError } = await user.rpc('authorize_health_probe');
    if (authorizeError || allowed !== true) throw new Error('FORBIDDEN');
    await rateLimit(`health:${identity.user.id}`, 10, 600, request);
    const run = async (component: string, operation: () => Promise<boolean>): Promise<Probe> => {
      const started = performance.now();
      try {
        const ok = await operation();
        return {
          component,
          status: ok ? 'HEALTHY' : 'UNAVAILABLE',
          latency: Math.min(60000, Math.round(performance.now() - started)),
          code: ok ? 'PROBE_OK' : 'PROBE_FAILED',
        };
      } catch {
        return {
          component,
          status: 'UNAVAILABLE',
          latency: Math.min(60000, Math.round(performance.now() - started)),
          code: 'PROBE_FAILED',
        };
      }
    };
    const results = await Promise.all([
      run('DATABASE', async () => {
        const { data, error } = await server.rpc('service_database_probe');
        return !error && data === true;
      }),
      run('AUTH', async () => {
        const { error } = await server.auth.admin.listUsers({ page: 1, perPage: 1 });
        return !error;
      }),
      run('STORAGE', async () => {
        const { error } = await server.storage.listBuckets();
        return !error;
      }),
      run(
        'REALTIME',
        () =>
          new Promise<boolean>((resolve) => {
            const channel = server.channel(`health:${crypto.randomUUID()}`);
            let settled = false;
            const finish = (ok: boolean) => {
              if (settled) return;
              settled = true;
              clearTimeout(timer);
              void server.removeChannel(channel);
              resolve(ok);
            };
            const timer = setTimeout(() => finish(false), 5000);
            channel.subscribe((status) => {
              if (status === 'SUBSCRIBED') finish(true);
              else if (['CHANNEL_ERROR', 'TIMED_OUT', 'CLOSED'].includes(status)) finish(false);
            });
          }),
      ),
    ]);
    results.push({ component: 'EDGE', status: 'HEALTHY', latency: null, code: 'PROBE_OK' });
    for (const result of results) {
      const { error } = await server.rpc('record_health_probe', {
        p_component: result.component,
        p_status: result.status,
        p_latency: result.latency,
        p_code: result.code,
        p_request: request.headers.get('x-request-id'),
      });
      if (error) throw new Error('REQUEST_FAILED');
    }
    return { results };
  }),
);
