import { readFile } from 'node:fs/promises';

const heartbeat = await readFile(
  new URL(
    '../supabase/migrations/20261005221652_step12_continuity_worker_heartbeat.sql',
    import.meta.url,
  ),
  'utf8',
);
const health = await readFile(
  new URL(
    '../supabase/migrations/20261005223140_step12_continuity_worker_health.sql',
    import.meta.url,
  ),
  'utf8',
);

const checks = [
  [heartbeat.includes('create table private.continuity_worker_heartbeats'), 'heartbeat table'],
  [
    heartbeat.includes("worker in ('BACKUP','RETENTION','RESTORE_TEST','RESTORE')"),
    'worker allowlist',
  ],
  [
    heartbeat.includes("status in ('POLLING','WORKING','IDLE','READY','ERROR')"),
    'status allowlist',
  ],
  [heartbeat.includes('enable row level security'), 'heartbeat RLS'],
  [
    heartbeat.includes(
      'grant execute on function public.record_continuity_worker_heartbeat(text,text,jsonb) to service_role',
    ),
    'service-role heartbeat grant',
  ],
  [
    health.includes('perform public.reconcile_all_continuity_alerts()'),
    'heartbeat triggers reconciliation',
  ],
  [health.includes('CONTINUITY_BACKUP_WORKER_UNAVAILABLE'), 'backup worker alert'],
  [health.includes('CONTINUITY_RETENTION_WORKER_UNAVAILABLE'), 'retention worker alert'],
  [health.includes('CONTINUITY_RESTORE_TEST_WORKER_UNAVAILABLE'), 'restore-test worker alert'],
  [health.includes('CONTINUITY_RESTORE_WORKER_UNAVAILABLE'), 'restore worker alert'],
  [health.includes("h.status<>'ERROR'"), 'error heartbeat unhealthy'],
  [
    health.includes(
      "'healthy',coalesce(h.last_seen_at>now()-w.max_age and h.status<>'ERROR',false)",
    ),
    'operational health healthy field',
  ],
];

const failed = checks.filter(([ok]) => !ok).map(([, label]) => label);
if (failed.length) {
  console.error(`STEP12_CONTINUITY_WORKER_HEALTH_GATE=FAILED:${failed.join(',')}`);
  process.exit(1);
}
console.log(`STEP12_CONTINUITY_WORKER_HEALTH_GATE=PASSED_${checks.length}_OF_${checks.length}`);
