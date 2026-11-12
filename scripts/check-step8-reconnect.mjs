import assert from 'node:assert/strict';
import { reconcileOfflineEvents, replayOfflineEvents } from '../src/offline/sync-engine.ts';

const user = '40000000-0000-4000-8000-000000000001';
const venue = '40000000-0000-4000-8000-000000000002';
const device = '40000000-0000-4000-8000-000000000003';
const ids = [1, 2, 3].map((n) => `41000000-0000-4000-8000-${String(n).padStart(12, '0')}`);
const events = ids.map((id, index) => ({
  client_event_id: id,
  user_id: user,
  device_id: device,
  venue_id: venue,
  predecessor_id: index ? ids[index - 1] : null,
  sync_status: 'PENDING',
}));
let persists = 0;
let syncCalls = [];
const persist = async () => {
  persists += 1;
};

await replayOfflineEvents(
  events,
  user,
  async (event) => {
    syncCalls.push(event.client_event_id);
    if (event.client_event_id === ids[0])
      return {
        client_event_id: event.client_event_id,
        sync_status: 'CONFLICT',
        result: { reason: 'VERSION_CONFLICT' },
      };
    return { client_event_id: event.client_event_id, sync_status: 'SYNCED', result: { ok: true } };
  },
  persist,
);
assert.deepEqual(syncCalls, [ids[0]], 'conflict blocks causal successors in same replay');
assert.equal(events[1].sync_status, 'PENDING');

let requestedIds = [];
await reconcileOfflineEvents(
  events,
  user,
  async (requestedVenue, clientEventIds) => {
    assert.equal(requestedVenue, venue);
    requestedIds.push(...clientEventIds);
    return [{ client_event_id: ids[0], sync_status: 'REJECTED', result: { action: 'DISCARD' } }];
  },
  persist,
);
assert.deepEqual(requestedIds, ids, 'reconciliation asks server about local history');
assert.equal(events[0].sync_status, 'REJECTED');

syncCalls = [];
await replayOfflineEvents(
  events,
  user,
  async (event) => {
    syncCalls.push(event.client_event_id);
    return { client_event_id: event.client_event_id, sync_status: 'SYNCED', result: { ok: true } };
  },
  persist,
);
assert.deepEqual(
  syncCalls,
  [ids[1], ids[2]],
  'terminal resolution releases successors in causal order',
);
assert.deepEqual(
  events.map((event) => event.sync_status),
  ['REJECTED', 'SYNCED', 'SYNCED'],
);
assert.ok(persists >= 4, 'state persisted after reconciliation and each replay');
console.log('STEP8_RECONNECT_GATE=PASSED');
