// Pure logic for the database-unavailable chaos harness. No network, no Deno.env:
// everything the harness touches is injected so it can be unit tested offline.
//
// The chaos is injected *client side only*: the "broken" client is a normal service-role
// Supabase client whose fetch transport throws before any byte leaves the process. The real
// database is never stopped, paused, throttled or reconfigured, so the harness cannot cause an
// outage on any environment.

export const RELEASE_TEST_KEY = 'DATABASE_UNAVAILABLE_CONTROLLED_CHAOS';
export const EXECUTED_BY = 'database-unavailable-chaos-probe';
export const CHAOS_ERROR = 'CHAOS_DATABASE_TRANSPORT_UNAVAILABLE';

export type RpcResult = { data: unknown; error: unknown };
export type Rpc = (fn: string, args: Record<string, unknown>) => Promise<RpcResult>;

/** Wraps an RPC so that thrown errors become `{ error }` results (never escape). */
export function safeRpc(rpc: Rpc): Rpc {
  return async (fn, args) => {
    try {
      const result = await rpc(fn, args);
      return { data: result.data ?? null, error: result.error ?? null };
    } catch (error) {
      return { data: null, error: error ?? new Error('RPC_THREW') };
    }
  };
}

/** A fetch implementation that simulates an unreachable database and counts attempts. */
export function failingTransport() {
  let attempts = 0;
  const fetchImpl: typeof fetch = (_input, _init) => {
    attempts++;
    return Promise.reject(new TypeError(CHAOS_ERROR));
  };
  return { fetch: fetchImpl, attempts: () => attempts };
}

const encoder = new TextEncoder();

/**
 * Constant-time comparison of the caller token against the configured token.
 * Both are hashed first so the comparison length never depends on the input.
 * Fails closed on missing / malformed values.
 */
export async function tokenMatches(
  expected: string | undefined | null,
  provided: string | undefined | null,
): Promise<boolean> {
  const shape = /^[\x21-\x7e]{32,512}$/;
  if (!expected || !shape.test(expected)) return false;
  const candidate = provided && shape.test(provided) ? provided : '';
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(expected)),
    crypto.subtle.digest('SHA-256', encoder.encode(candidate)),
  ]);
  const x = new Uint8Array(a),
    y = new Uint8Array(b);
  let difference = candidate.length === 0 ? 1 : 0;
  for (let i = 0; i < x.length; i++) difference |= x[i]! ^ y[i]!;
  return difference === 0;
}

/** Environments where the harness refuses to run (fail closed). */
export function environmentAllowed(environment: string | undefined | null): boolean {
  const value = (environment ?? 'development').trim().toLowerCase();
  return !['production', 'prod'].includes(value);
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function errorCode(error: unknown): string {
  const message =
    error instanceof Error
      ? error.message
      : typeof record(error)?.message === 'string'
        ? (record(error)!.message as string)
        : '';
  // Report only a classification, never raw driver messages.
  return message.includes(CHAOS_ERROR) ? CHAOS_ERROR : 'DATABASE_REQUEST_FAILED';
}

export type ProbeChecks = {
  chaos_transport_attempted: boolean;
  chaos_failed_explicitly: boolean;
  chaos_returned_no_data: boolean;
  zero_mutation_under_chaos: boolean;
  healthy_write_succeeded: boolean;
  healthy_read_back_matches: boolean;
  sentinel_deleted: boolean;
  sentinel_absent_after_cleanup: boolean;
};

export type ProbeOutcome = {
  status: 'PASS' | 'FAIL';
  evidence: Record<string, unknown>;
};

export type ProbeDeps = {
  /** RPC over the real, healthy service-role transport. */
  healthy: Rpc;
  /** RPC over the same service-role client configuration but with the failing transport. */
  broken: Rpc;
  /** Number of times the failing transport was invoked. */
  brokenAttempts: () => number;
  id: string;
  marker: string;
  now?: () => number;
};

async function readProbe(healthy: Rpc, id: string) {
  const { data, error } = await healthy('read_database_chaos_probe', { p_id: id });
  const row = record(data);
  if (error || !row || typeof row.exists !== 'boolean') return null;
  return { exists: row.exists, marker: typeof row.marker === 'string' ? row.marker : null };
}

/**
 * Runs the controlled chaos scenario:
 *  1. service-role mutation through the failing transport must fail explicitly and return no data;
 *  2. a healthy read must show zero mutation happened;
 *  3. the same mutation through the healthy transport must succeed and read back;
 *  4. the sentinel is always deleted (also on failure) and verified absent.
 */
export async function runChaosProbe(deps: ProbeDeps): Promise<ProbeOutcome> {
  const healthy = safeRpc(deps.healthy),
    broken = safeRpc(deps.broken),
    now = deps.now ?? (() => performance.now());
  const args = { p_id: deps.id, p_marker: deps.marker };
  const checks: ProbeChecks = {
    chaos_transport_attempted: false,
    chaos_failed_explicitly: false,
    chaos_returned_no_data: false,
    zero_mutation_under_chaos: false,
    healthy_write_succeeded: false,
    healthy_read_back_matches: false,
    sentinel_deleted: false,
    sentinel_absent_after_cleanup: false,
  };
  let chaosError = 'NONE',
    chaosLatency = 0;
  let healthyFailure: string | null = null;
  try {
    const before = deps.brokenAttempts(),
      started = now();
    const chaos = await broken('write_database_chaos_probe', args);
    chaosLatency = Math.max(0, Math.round(now() - started));
    checks.chaos_transport_attempted = deps.brokenAttempts() > before;
    checks.chaos_failed_explicitly = chaos.error !== null && chaos.error !== undefined;
    checks.chaos_returned_no_data = chaos.data === null || chaos.data === undefined;
    if (checks.chaos_failed_explicitly) chaosError = errorCode(chaos.error);

    const afterChaos = await readProbe(healthy, deps.id);
    if (!afterChaos) healthyFailure = 'READ_AFTER_CHAOS_FAILED';
    checks.zero_mutation_under_chaos = afterChaos?.exists === false;

    if (!healthyFailure) {
      const write = await healthy('write_database_chaos_probe', args);
      const written = record(write.data);
      checks.healthy_write_succeeded =
        !write.error && written?.written === true && written?.id === deps.id;
      if (!checks.healthy_write_succeeded) healthyFailure = 'HEALTHY_WRITE_FAILED';
      else {
        const readBack = await readProbe(healthy, deps.id);
        checks.healthy_read_back_matches =
          readBack?.exists === true && readBack.marker === deps.marker;
        if (!checks.healthy_read_back_matches) healthyFailure = 'HEALTHY_READ_BACK_FAILED';
      }
    }
  } finally {
    // Cleanup runs even if a step above failed or a fake threw.
    const removed = await healthy('delete_database_chaos_probe', { p_id: deps.id });
    const removedRow = record(removed.data);
    // `deleted` is false when nothing was written (e.g. healthy write failed): only the
    // post-cleanup absence check decides whether the sentinel is gone.
    checks.sentinel_deleted =
      !removed.error && (removedRow?.deleted === true || !checks.healthy_write_succeeded);
    const final = await readProbe(healthy, deps.id);
    checks.sentinel_absent_after_cleanup = final?.exists === false;
  }
  const status = Object.values(checks).every(Boolean) ? 'PASS' : 'FAIL';
  return {
    status,
    evidence: {
      probe_id: deps.id,
      injected_fault: 'EDGE_DATABASE_TRANSPORT_UNREACHABLE',
      target_rpc: 'write_database_chaos_probe',
      chaos_error_code: chaosError,
      chaos_transport_attempts: deps.brokenAttempts(),
      chaos_latency_ms: Math.min(60000, chaosLatency),
      healthy_failure: healthyFailure,
      checks,
    },
  };
}
