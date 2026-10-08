import assert from 'node:assert/strict';
import {
  applyRemoteStatuses,
  chunkClientEventIds,
  nextPredecessorId,
  predecessorSatisfied,
} from '../src/offline/queue-causality.ts';

const user = '00000000-0000-4000-8000-000000000001';
const device = '00000000-0000-4000-8000-000000000002';
const venue = '00000000-0000-4000-8000-000000000003';
const otherVenue = '00000000-0000-4000-8000-000000000004';
const first = {
  client_event_id: '10000000-0000-4000-8000-000000000001',
  user_id: user,
  device_id: device,
  venue_id: venue,
  predecessor_id: null,
  sync_status: 'CONFLICT',
  result: { reason: 'VERSION_CONFLICT' },
};
const second = {
  client_event_id: '10000000-0000-4000-8000-000000000002',
  user_id: user,
  device_id: device,
  venue_id: venue,
  predecessor_id: first.client_event_id,
  sync_status: 'PENDING',
};
const third = {
  client_event_id: '10000000-0000-4000-8000-000000000003',
  user_id: user,
  device_id: device,
  venue_id: venue,
  predecessor_id: second.client_event_id,
  sync_status: 'PENDING',
};
const events = [first, second, third];
assert.equal(predecessorSatisfied(events, second), false, 'open conflict blocks successor');
assert.equal(
  applyRemoteStatuses(events, [
    {
      client_event_id: first.client_event_id,
      sync_status: 'REJECTED',
      result: { action: 'DISCARD' },
    },
  ]),
  true,
);
assert.equal(predecessorSatisfied(events, second), true, 'REJECTED predecessor is terminal');
second.sync_status = 'SYNCED';
assert.equal(predecessorSatisfied(events, third), true, 'SYNCED predecessor is terminal');
assert.equal(
  nextPredecessorId(events, user, device, venue),
  third.client_event_id,
  'latest same-context event is predecessor',
);
assert.equal(
  nextPredecessorId(events, user, device, otherVenue),
  null,
  'other venue starts independent causal chain',
);

const many = Array.from({ length: 1001 }, (_, index) => ({
  client_event_id: `20000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
  user_id: user,
  device_id: device,
  venue_id: venue,
  predecessor_id: null,
  sync_status: 'SYNCED',
}));
const chunks = chunkClientEventIds(many, user, venue);
assert.deepEqual(
  chunks.map((chunk) => chunk.length),
  [500, 500, 1],
  'reconciliation respects server 500-event limit',
);
assert.throws(() => chunkClientEventIds(many, user, venue, 501), /INVALID_SYNC_CHUNK_SIZE/);
console.log('STEP8_CAUSALITY_GATE=PASSED');
