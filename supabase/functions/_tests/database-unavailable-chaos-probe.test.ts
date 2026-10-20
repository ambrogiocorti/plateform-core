import { createClient } from 'npm:@supabase/supabase-js@2.116.0';
import {
  CHAOS_ERROR,
  environmentAllowed,
  failingTransport,
  runChaosProbe,
  tokenMatches,
  type Rpc,
} from '../database-unavailable-chaos-probe/probe.ts';

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

/** In-memory model of the write/read/delete_database_chaos_probe RPCs. */
function fakeDatabase(options: { failWrite?: boolean; ignoreDelete?: boolean } = {}) {
  const rows = new Map<string, string>();
  const rpc: Rpc = (fn, args) => {
    const id = args.p_id as string;
    if (fn === 'write_database_chaos_probe') {
      if (options.failWrite) return Promise.resolve({ data: null, error: { message: 'boom' } });
      rows.set(id, args.p_marker as string);
      return Promise.resolve({ data: { id, written: true }, error: null });
    }
    if (fn === 'read_database_chaos_probe')
      return Promise.resolve({
        data: { exists: rows.has(id), marker: rows.get(id) ?? null },
        error: null,
      });
    if (fn === 'delete_database_chaos_probe') {
      const deleted = !options.ignoreDelete && rows.delete(id);
      return Promise.resolve({ data: { id, deleted }, error: null });
    }
    return Promise.resolve({ data: null, error: { message: 'unknown rpc' } });
  };
  return { rows, rpc };
}

const id = '6f1d0c1e-8d55-4a39-9a51-6f0f3f1b7a10';

Deno.test(
  'Chaos probe passes when broken transport fails closed and healthy path works',
  async () => {
    const db = fakeDatabase();
    const transport = failingTransport();
    const broken: Rpc = async () => {
      await transport.fetch('https://db.invalid/rest/v1/rpc/write_database_chaos_probe');
      return { data: { written: true }, error: null };
    };
    const outcome = await runChaosProbe({
      healthy: db.rpc,
      broken,
      brokenAttempts: transport.attempts,
      id,
      marker: 'chaos:test',
    });
    assert(outcome.status === 'PASS', `Expected PASS: ${JSON.stringify(outcome.evidence)}`);
    assert(outcome.evidence.chaos_error_code === CHAOS_ERROR, 'Chaos error not classified');
    assert(db.rows.size === 0, 'Sentinel not cleaned');
  },
);

Deno.test('Chaos probe fails when a mutation succeeds despite the injected outage', async () => {
  const db = fakeDatabase();
  let attempts = 0;
  // A transport that silently "succeeds": the harness must detect the leaked mutation.
  const leaky: Rpc = (fn, args) => {
    attempts++;
    return db.rpc(fn, args);
  };
  const outcome = await runChaosProbe({
    healthy: db.rpc,
    broken: leaky,
    brokenAttempts: () => attempts,
    id,
    marker: 'chaos:test',
  });
  const checks = outcome.evidence.checks as Record<string, boolean>;
  assert(outcome.status === 'FAIL', 'Leaked mutation was not detected');
  assert(!checks.chaos_failed_explicitly && !checks.zero_mutation_under_chaos, 'Wrong checks');
  assert(db.rows.size === 0, 'Sentinel left behind after failed run');
});

Deno.test('Chaos probe reports FAIL when the healthy path or cleanup fails', async () => {
  const transport = failingTransport();
  const broken: Rpc = async () => {
    await transport.fetch('https://db.invalid/');
    return { data: null, error: null };
  };
  const writeFails = await runChaosProbe({
    healthy: fakeDatabase({ failWrite: true }).rpc,
    broken,
    brokenAttempts: transport.attempts,
    id,
    marker: 'm',
  });
  assert(writeFails.status === 'FAIL', 'Healthy write failure not reported');
  assert(writeFails.evidence.healthy_failure === 'HEALTHY_WRITE_FAILED', 'Wrong failure code');
  const stuck = fakeDatabase({ ignoreDelete: true });
  const cleanupFails = await runChaosProbe({
    healthy: stuck.rpc,
    broken,
    brokenAttempts: transport.attempts,
    id,
    marker: 'm',
  });
  assert(cleanupFails.status === 'FAIL', 'Cleanup failure not reported');
});

Deno.test('Chaos probe survives a throwing healthy RPC and never throws itself', async () => {
  const transport = failingTransport();
  const outcome = await runChaosProbe({
    healthy: () => Promise.reject(new Error('network down')),
    broken: async () => {
      await transport.fetch('https://db.invalid/');
      return { data: null, error: null };
    },
    brokenAttempts: transport.attempts,
    id,
    marker: 'm',
  });
  assert(outcome.status === 'FAIL', 'Real outage must report FAIL, not PASS');
});

Deno.test(
  'supabase-js over the failing transport returns an explicit error and no data',
  async () => {
    const transport = failingTransport();
    const client = createClient('https://chaos.invalid', 'service-role-test-key', {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { fetch: transport.fetch },
    });
    let result: { data: unknown; error: unknown };
    try {
      result = await client.rpc('write_database_chaos_probe', { p_id: id, p_marker: 'm' });
    } catch (error) {
      result = { data: null, error };
    }
    assert(transport.attempts() >= 1, 'Transport was not used');
    assert(result.error, 'Missing explicit error');
    assert(result.data === null || result.data === undefined, 'Data returned under outage');
  },
);

Deno.test('Chaos token comparison fails closed', async () => {
  const token = 'a'.repeat(64);
  assert(await tokenMatches(token, token), 'Valid token rejected');
  assert(!(await tokenMatches(token, 'b'.repeat(64))), 'Wrong token accepted');
  assert(!(await tokenMatches(token, null)), 'Missing token accepted');
  assert(!(await tokenMatches(token, '')), 'Empty token accepted');
  assert(!(await tokenMatches(undefined, token)), 'Unconfigured secret accepted');
  assert(!(await tokenMatches('short', 'short')), 'Weak secret accepted');
});

Deno.test('Chaos harness refuses production environments', () => {
  assert(environmentAllowed(undefined), 'Default environment refused');
  assert(environmentAllowed('staging'), 'Staging refused');
  assert(!environmentAllowed('production'), 'Production allowed');
  assert(!environmentAllowed(' Production '), 'Production (case) allowed');
  assert(!environmentAllowed('prod'), 'prod allowed');
});
