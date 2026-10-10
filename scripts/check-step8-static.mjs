import fs from 'node:fs';
const files = {
  store: fs.readFileSync('src/offline/store.ts', 'utf8'),
  page: fs.readFileSync('src/pages/offline.ts', 'utf8'),
  main: fs.readFileSync('apps/staff/main.ts', 'utf8'),
  policy: fs.readFileSync('src/offline/queue-policy.ts', 'utf8'),
  engine: fs.readFileSync('src/offline/sync-engine.ts', 'utf8'),
};
const checks = [
  ['queue accepts rejected/resolved', files.store.includes("'REJECTED', 'RESOLVED'")],
  ['enqueue uses causal predecessor', files.store.includes('predecessorFor(queue')],
  ['server statuses reconciled', files.page.includes("'get_offline_sync_statuses'")],
  [
    'remote status applied',
    files.page.includes('reconcileQueueStatuses(events, remote)') ||
      files.engine.includes('reconcileQueueStatuses(events, statuses)'),
  ],
  [
    'causal blocker helper used',
    files.page.includes('hasBlockingPredecessor(events, event)') ||
      files.engine.includes('hasBlockingPredecessor(events, event)'),
  ],
  ['sync allows terminal server outcomes', files.page.includes("'REJECTED', 'RESOLVED'")],
  [
    'post reconnect refresh exported',
    files.page.includes('export async function reconcileAfterReconnect'),
  ],
  ['refresh reissues authorization', files.page.includes('await prepareOffline(context, false)')],
  ['refresh failure clears sensitive offline state', files.page.includes('await clearOffline()')],
  [
    'browser online path invokes reconciliation',
    files.main.includes('offline.reconcileAfterReconnect(currentContext)'),
  ],
  ['terminal policy includes rejected', files.policy.includes("'REJECTED'")],
  ['terminal policy includes resolved', files.policy.includes("'RESOLVED'")],
  ['policy is venue scoped', files.policy.includes('candidate.venue_id === next.venue_id')],
  ['policy is user scoped', files.policy.includes('candidate.user_id === next.user_id')],
  [
    'prepare blocks nonterminal foreign queue',
    files.page.includes(
      '!isTerminalOfflineStatus(e.sync_status) && e.user_id !== context.profile.id',
    ),
  ],
  [
    'offline actions hide resources with nonterminal queue',
    files.page.includes('!isTerminalOfflineStatus(event.sync_status)'),
  ],
];
const failed = checks.filter(([, ok]) => !ok);
for (const [name, ok] of checks) console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
if (failed.length) process.exit(1);
console.log(`STEP8_STATIC_GATE=PASSED ${checks.length}/${checks.length}`);
