export type OfflineSyncStatus =
  'PENDING' | 'SYNCING' | 'SYNCED' | 'CONFLICT' | 'REJECTED' | 'RESOLVED';

export interface CausalQueueEvent {
  client_event_id: string;
  user_id: string;
  device_id: string;
  venue_id: string;
  predecessor_id: string | null;
  sync_status: OfflineSyncStatus;
  result?: unknown;
}

export interface RemoteSyncStatus {
  client_event_id: string;
  sync_status: OfflineSyncStatus;
  result?: unknown;
}

const TERMINAL_PREDECESSOR_STATUSES = new Set<OfflineSyncStatus>([
  'SYNCED',
  'REJECTED',
  'RESOLVED',
]);

export function nextPredecessorId(
  events: readonly CausalQueueEvent[],
  userId: string,
  deviceId: string,
  venueId: string,
): string | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (
      event &&
      event.user_id === userId &&
      event.device_id === deviceId &&
      event.venue_id === venueId
    )
      return event.client_event_id;
  }
  return null;
}

export function predecessorSatisfied(
  events: readonly CausalQueueEvent[],
  event: CausalQueueEvent,
): boolean {
  if (!event.predecessor_id) return true;
  const predecessor = events.find(
    (candidate) => candidate.client_event_id === event.predecessor_id,
  );
  return predecessor ? TERMINAL_PREDECESSOR_STATUSES.has(predecessor.sync_status) : false;
}

export function applyRemoteStatuses<T extends CausalQueueEvent>(
  events: T[],
  statuses: readonly RemoteSyncStatus[],
): boolean {
  const byId = new Map(statuses.map((status) => [status.client_event_id, status]));
  let changed = false;
  for (const event of events) {
    const remote = byId.get(event.client_event_id);
    if (!remote) continue;
    if (event.sync_status !== remote.sync_status || event.result !== remote.result) {
      event.sync_status = remote.sync_status;
      event.result = remote.result;
      changed = true;
    }
  }
  return changed;
}

export function chunkClientEventIds(
  events: readonly CausalQueueEvent[],
  userId: string,
  venueId: string,
  size = 500,
): string[][] {
  if (!Number.isInteger(size) || size < 1 || size > 500) throw new Error('INVALID_SYNC_CHUNK_SIZE');
  const ids = events
    .filter((event) => event.user_id === userId && event.venue_id === venueId)
    .map((event) => event.client_event_id);
  const chunks: string[][] = [];
  for (let index = 0; index < ids.length; index += size)
    chunks.push(ids.slice(index, index + size));
  return chunks;
}
