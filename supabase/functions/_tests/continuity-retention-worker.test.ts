import {
  authorize,
  OVERDUE_GRACE_MS,
  requestSchema,
  type RetentionDeps,
  runDispatch,
  workerTokenShape,
} from '../continuity-retention-worker/logic.ts';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
async function rejects(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise;
  } catch (error) {
    assert(error instanceof Error && error.message === code, `Expected ${code}, got ${error}`);
    return;
  }
  throw new Error(`Expected ${code}`);
}

const NOW = Date.parse('2026-10-20T12:00:00Z');
const TOKEN = 'a'.repeat(64);
const incident = (action: string) => ({ id: null, action, status: null });

function deps(overrides: Partial<RetentionDeps> = {}, rows: unknown[] = [], count = rows.length) {
  const calls: string[] = [];
  const base: RetentionDeps = {
    verifyToken: async (token) => {
      calls.push('verify');
      return { data: token === TOKEN, error: null };
    },
    reconcile: async () => {
      calls.push('reconcile');
      return {
        data: {
          continuity: {
            checked_at: new Date(NOW).toISOString(),
            active_count: 2,
            results: [incident('NONE'), incident('OPENED'), incident('UNCHANGED')],
          },
          cutover: incident('NONE'),
          retention: incident('UNCHANGED'),
        },
        error: null,
      };
    },
    listBacklog: async (nowIso, limit) => {
      calls.push(`backlog:${nowIso}:${limit}`);
      return { data: rows, error: null, count };
    },
    now: () => NOW,
  };
  return { deps: { ...base, ...overrides }, calls };
}

const row = (hoursAgo: number, extra: Record<string, unknown> = {}) => ({
  id: crypto.randomUUID(),
  retention_until: new Date(NOW - hoursAgo * 3600_000).toISOString(),
  purge_attempts: 0,
  purge_error_code: null,
  purge_lease_expires_at: null,
  ...extra,
});

Deno.test('request body matches the database dispatch exactly', () => {
  assert(requestSchema.safeParse({ source: 'cron', worker: 'RETENTION' }).success, 'DB body');
  assert(!requestSchema.safeParse({}).success, 'empty body accepted');
  assert(!requestSchema.safeParse({ source: 'cron', worker: 'BACKUP' }).success, 'wrong worker');
  assert(
    !requestSchema.safeParse({ source: 'cron', worker: 'RETENTION', p_lease_seconds: 60 }).success,
    'extra keys accepted',
  );
});

Deno.test('worker token is required, well formed and verified by the database', async () => {
  assert(!workerTokenShape(null) && !workerTokenShape('short'), 'short token accepted');
  assert(!workerTokenShape(`${'a'.repeat(63)} `), 'whitespace accepted');
  assert(!workerTokenShape('a'.repeat(257)), 'oversized token accepted');
  assert(workerTokenShape(TOKEN), 'valid token rejected');

  const missing = deps();
  await rejects(authorize(missing.deps, null), 'UNAUTHORIZED');
  assert(missing.calls.length === 0, 'malformed token reached the database');

  await rejects(authorize(deps().deps, 'b'.repeat(64)), 'UNAUTHORIZED');
  await authorize(deps().deps, TOKEN);

  const failing = deps({ verifyToken: async () => ({ data: null, error: { code: '42501' } }) });
  await rejects(authorize(failing.deps, TOKEN), 'UNAUTHORIZED');
  const truthy = deps({ verifyToken: async () => ({ data: 'true', error: null }) });
  await rejects(authorize(truthy.deps, TOKEN), 'UNAUTHORIZED');
});

Deno.test('empty backlog reports IDLE after reconciling alerts', async () => {
  const { deps: d, calls } = deps();
  const result = await runDispatch(d);
  assert(result.status === 'IDLE' && result.expired_unpurged === 0, 'not idle');
  assert(result.purge_performed_by === 'continuity-host', 'purge owner missing');
  assert(
    result.alerts?.continuity_changes === 1 &&
      result.alerts.continuity_active === 2 &&
      result.alerts.retention_overdue === 'UNCHANGED',
    'alerts',
  );
  assert(calls[0] === 'reconcile', 'alerts not reconciled first');
  assert(calls[1] === `backlog:${new Date(NOW).toISOString()}:25`, 'backlog query');
});

Deno.test('backlog within grace is pending, beyond 6 hours is overdue', async () => {
  const pending = await runDispatch(deps({}, [row(1)]).deps);
  assert(pending.status === 'PENDING_HOST_WORKER' && pending.overdue === 0, 'pending');

  const leaseFuture = new Date(NOW + 60_000).toISOString();
  const overdue = await runDispatch(
    deps(
      {},
      [
        row(OVERDUE_GRACE_MS / 3600_000 + 1, { purge_error_code: 'RETENTION_UNSAFE_DIRECTORY' }),
        row(2, { purge_lease_expires_at: leaseFuture, purge_attempts: 3 }),
      ],
      40,
    ).deps,
  );
  assert(overdue.status === 'OVERDUE' && overdue.overdue === 1, 'overdue');
  assert(overdue.failing === 1 && overdue.leased === 1, 'failing/leased');
  assert(overdue.expired_unpurged === 40, 'exact count not used');
});

Deno.test('backlog failures fail closed; alert reconciliation failure is reported', async () => {
  const noAlerts = await runDispatch(
    deps({ reconcile: async () => ({ data: null, error: { code: '42501' } }) }, [row(1)]).deps,
  );
  assert(noAlerts.alerts === null && noAlerts.status === 'PENDING_HOST_WORKER', 'rpc error');
  const malformed = await runDispatch(
    deps({ reconcile: async () => ({ data: { unexpected: true }, error: null }) }).deps,
  );
  assert(malformed.alerts === null && malformed.status === 'IDLE', 'malformed alerts');
  const thrown = await runDispatch(
    deps({
      reconcile: () => Promise.reject(new Error('network')),
    }).deps,
  );
  assert(thrown.alerts === null, 'thrown reconcile');
  await rejects(
    runDispatch(
      deps({ listBacklog: async () => ({ data: null, error: { code: '42501' }, count: null }) })
        .deps,
    ),
    'REQUEST_FAILED',
  );
  await rejects(
    runDispatch(deps({}, [{ id: 'not-a-uuid', retention_until: 'x' }]).deps),
    'REQUEST_FAILED',
  );
});

Deno.test('the dispatch only reconciles alerts and reads the backlog', async () => {
  // RetentionDeps has no claim/finish/heartbeat/delete capability: the purge belongs to the
  // continuity host, which must remove both copies before finish_backup_retention_job.
  const { deps: d, calls } = deps({}, [row(10), row(9)]);
  await runDispatch(d);
  assert(
    calls.length === 2 && calls[0] === 'reconcile' && calls[1]!.startsWith('backlog:'),
    'calls',
  );
  assert(
    Object.keys(d).sort().join(',') === 'listBacklog,now,reconcile,verifyToken',
    'unexpected side-effect capability',
  );
});
