// Internal chaos harness invoked by public.invoke_database_unavailable_chaos_probe() via pg_net:
//   POST <edge base>/database-unavailable-chaos-probe, body {}, headers
//   Content-Type: application/json, x-plateform-chaos-token: <vault plateform_database_chaos_probe_token>
// No JWT is sent, so the gateway must run with verify_jwt = false; authority comes only from the
// shared token (constant-time compare). The fault is injected in this process only (a failing
// fetch transport), never in the database, so the probe cannot cause an outage.
//
// Env: DATABASE_CHAOS_PROBE_TOKEN (copy of the Vault secret), SUPABASE_URL,
// SUPABASE_SERVICE_ROLE_KEY, ENVIRONMENT (refuses on production), plus the shared endpoint vars.
import { createClient } from 'npm:@supabase/supabase-js@2.116.0';
import { z } from 'npm:zod@4.6.5';
import { endpoint, rateLimit, secret, serverClient } from '../_shared/http.ts';
import {
  EXECUTED_BY,
  RELEASE_TEST_KEY,
  environmentAllowed,
  failingTransport,
  runChaosProbe,
  tokenMatches,
  type Rpc,
} from './probe.ts';

Deno.serve(
  endpoint(z.object({}).strict(), async (_body, request) => {
    if (
      !(await tokenMatches(
        Deno.env.get('DATABASE_CHAOS_PROBE_TOKEN'),
        request.headers.get('x-plateform-chaos-token'),
      ))
    )
      throw new Error('UNAUTHORIZED');
    if (!environmentAllowed(Deno.env.get('ENVIRONMENT'))) throw new Error('FORBIDDEN');
    await rateLimit('chaos:database-unavailable', 6, 3600, request);

    const server = serverClient(request);
    const transport = failingTransport();
    // Same privileged configuration as the real server client; only the transport is broken.
    const broken = createClient(secret('SUPABASE_URL'), secret('SUPABASE_SERVICE_ROLE_KEY'), {
      auth: { persistSession: false, autoRefreshToken: false },
      global: {
        fetch: transport.fetch,
        headers: { 'x-request-id': request.headers.get('x-request-id') ?? crypto.randomUUID() },
      },
    });
    const healthyRpc: Rpc = async (fn, args) => await server.rpc(fn, args);
    const brokenRpc: Rpc = async (fn, args) => await broken.rpc(fn, args);

    const id = crypto.randomUUID();
    const outcome = await runChaosProbe({
      healthy: healthyRpc,
      broken: brokenRpc,
      brokenAttempts: transport.attempts,
      id,
      marker: `chaos:${request.headers.get('x-request-id') ?? id}`.slice(0, 200),
    });
    const evidence = {
      ...outcome.evidence,
      environment: Deno.env.get('ENVIRONMENT') ?? 'development',
      release_version: Deno.env.get('RELEASE_VERSION') ?? '0.1.0',
      request_id: request.headers.get('x-request-id'),
    };
    const { error } = await server.rpc('record_release_test_result', {
      p_key: RELEASE_TEST_KEY,
      p_status: outcome.status,
      p_evidence: evidence,
      p_executed_by: EXECUTED_BY,
    });
    if (error) throw new Error('REQUEST_FAILED');
    return { key: RELEASE_TEST_KEY, status: outcome.status, evidence };
  }),
);
