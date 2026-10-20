// Pure logic of the continuity RETENTION dispatch. No network, no Deno.serve: every side effect
// is injected so the contract can be unit tested.
//
// DB contract (latest: 20261019090000 private.dispatch_continuity_retention_worker):
//   net.http_post(private.edge_function_url('continuity-retention-worker'),
//     body {"source":"cron","worker":"RETENTION"}, timeout 5000 ms,
//     headers: authorization/apikey = anon JWT, x-plateform-worker-token = runtime worker_token)
//   The worker token lives only in private.continuity_worker_runtime_config and is checked by
//   public.verify_continuity_worker_token(p_token) (service_role, SHA-256 digest comparison).
//
// Why this function never claims a purge lease:
//   Backup artifacts live on the continuity host (PLATEFORM_BACKUP_ROOT and
//   PLATEFORM_BACKUP_REPLICA_ROOT, references plateform-backup://<id>/manifest.json#database).
//   finish_backup_retention_job(p_success=true) nulls the references and records
//   BACKUP_ARTIFACTS_PURGED, so it may only follow the physical removal of BOTH copies, which only
//   tools/backup-retention-worker can perform. Claiming here would either declare data purged
//   that still exists, or burn leases/purge_attempts (capped at 100) and block the host worker.
//   It also never records the RETENTION heartbeat: that heartbeat is the evidence the host worker
//   is alive (CONTINUITY_RETENTION_WORKER_UNAVAILABLE) and must not be masked.
//
// What it does: authenticate, reconcile the continuity alerts through the authorised
// public.reconcile_all_continuity_alerts() (opens/resolves CONTINUITY_RETENTION_OVERDUE and
// CONTINUITY_RETENTION_WORKER_UNAVAILABLE), and report the expired-but-unpurged backlog read-only.
import { z } from 'npm:zod@4.6.5';

export const requestSchema = z
  .object({ source: z.literal('cron'), worker: z.literal('RETENTION') })
  .strict();

/** worker_token column: check(length(worker_token) between 64 and 256). */
export function workerTokenShape(token: string | null): token is string {
  return typeof token === 'string' && /^[\x21-\x7e]{64,256}$/.test(token);
}

/** Same tolerance as private.reconcile_backup_retention_alert(). */
export const OVERDUE_GRACE_MS = 6 * 60 * 60 * 1000;
export const BACKLOG_SAMPLE = 25;

export const backlogRowSchema = z
  .object({
    id: z.uuid(),
    retention_until: z.string().min(1),
    purge_attempts: z.number().int().min(0).max(100),
    purge_error_code: z.string().max(80).nullable(),
    purge_lease_expires_at: z.string().nullable(),
  })
  .passthrough();
export type BacklogRow = z.infer<typeof backlogRowSchema>;

const incidentSchema = z
  .object({
    id: z.uuid().nullable(),
    action: z.enum(['OPENED', 'UPDATED', 'UNCHANGED', 'RESOLVED', 'NONE']),
  })
  .passthrough();
// public.reconcile_all_continuity_alerts() -> {continuity:{checked_at,active_count,results[]},
// cutover:{...}, retention:{id,action,status}} (20261004143611 / 20261005223140).
const reconcileSchema = z
  .object({
    continuity: z
      .object({
        active_count: z.number().int().min(0),
        results: z.array(incidentSchema),
      })
      .passthrough(),
    retention: incidentSchema,
  })
  .passthrough();

export interface RetentionDeps {
  verifyToken: (token: string) => Promise<{ data: unknown; error: unknown }>;
  reconcile: () => Promise<{ data: unknown; error: unknown }>;
  listBacklog: (
    nowIso: string,
    limit: number,
  ) => Promise<{ data: unknown; error: unknown; count: number | null }>;
  now: () => number;
}

export type DispatchStatus = 'IDLE' | 'PENDING_HOST_WORKER' | 'OVERDUE';

export interface DispatchResult {
  worker: 'RETENTION';
  status: DispatchStatus;
  purge_performed_by: 'continuity-host';
  expired_unpurged: number;
  overdue: number;
  leased: number;
  failing: number;
  oldest_retention_until: string | null;
  /** null when the reconcile RPC was unavailable; cron plateform-continuity-alerts still runs it. */
  alerts: {
    retention_overdue: string;
    continuity_changes: number;
    continuity_active: number;
  } | null;
}

export async function authorize(deps: RetentionDeps, token: string | null): Promise<void> {
  if (!workerTokenShape(token)) throw new Error('UNAUTHORIZED');
  const { data, error } = await deps.verifyToken(token);
  // Any RPC failure (missing runtime config, network) fails closed.
  if (error || data !== true) throw new Error('UNAUTHORIZED');
}

export function summarize(
  rows: BacklogRow[],
  total: number,
  nowMs: number,
): Omit<DispatchResult, 'alerts' | 'worker' | 'purge_performed_by'> {
  let overdue = 0,
    leased = 0,
    failing = 0;
  for (const row of rows) {
    const until = Date.parse(row.retention_until);
    if (!Number.isFinite(until)) throw new Error('REQUEST_FAILED');
    if (until < nowMs - OVERDUE_GRACE_MS) overdue++;
    const lease = row.purge_lease_expires_at ? Date.parse(row.purge_lease_expires_at) : NaN;
    if (Number.isFinite(lease) && lease > nowMs) leased++;
    if (row.purge_error_code) failing++;
  }
  const expired = Math.max(total, rows.length);
  return {
    status: expired === 0 ? 'IDLE' : overdue > 0 ? 'OVERDUE' : 'PENDING_HOST_WORKER',
    expired_unpurged: expired,
    overdue,
    leased,
    failing,
    oldest_retention_until: rows[0]?.retention_until ?? null,
  };
}

/** Called only after authorize(). Never deletes, never claims, never writes a heartbeat. */
export async function runDispatch(deps: RetentionDeps): Promise<DispatchResult> {
  const nowMs = deps.now();
  // Alert reconciliation is idempotent and also scheduled every 10 minutes by the database
  // (cron plateform-continuity-alerts), so a failure here is reported, not fatal.
  let alerts: DispatchResult['alerts'] = null;
  try {
    const reconciled = await deps.reconcile();
    const parsed = reconciled.error ? null : reconcileSchema.safeParse(reconciled.data);
    if (parsed?.success)
      alerts = {
        retention_overdue: parsed.data.retention.action,
        continuity_changes: parsed.data.continuity.results.filter((item) =>
          ['OPENED', 'UPDATED', 'RESOLVED'].includes(item.action),
        ).length,
        continuity_active: parsed.data.continuity.active_count,
      };
  } catch {
    alerts = null;
  }

  const backlog = await deps.listBacklog(new Date(nowMs).toISOString(), BACKLOG_SAMPLE);
  if (backlog.error) throw new Error('REQUEST_FAILED');
  const rows = z
    .array(backlogRowSchema)
    .max(BACKLOG_SAMPLE)
    .safeParse(backlog.data ?? []);
  if (!rows.success) throw new Error('REQUEST_FAILED');

  return {
    worker: 'RETENTION',
    purge_performed_by: 'continuity-host',
    ...summarize(rows.data, backlog.count ?? rows.data.length, nowMs),
    alerts,
  };
}
