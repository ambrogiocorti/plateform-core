import type { SyncStatus } from '../types/domain';

export const terminalOfflineStatuses = new Set<SyncStatus>(['SYNCED', 'REJECTED', 'RESOLVED']);

export type CausalQueueEvent = {
  client_event_id: string;
  user_id: string;
  venue_id: string;
  resource_id: string;
  sync_status: SyncStatus;
  predecessor_id: string | null;
};

export function isTerminalOfflineStatus(status: SyncStatus): boolean {
  return terminalOfflineStatuses.has(status);
}

export function predecessorFor(
  queue: readonly CausalQueueEvent[],
  next: Pick<CausalQueueEvent, 'user_id' | 'venue_id'>,
): string | null {
  for (let index = queue.length - 1; index >= 0; index -= 1) {
    const candidate = queue[index]!;
    if (
      candidate.user_id === next.user_id &&
      candidate.venue_id === next.venue_id &&
      !isTerminalOfflineStatus(candidate.sync_status)
    )
      return candidate.client_event_id;
  }
  return null;
}

export function hasBlockingPredecessor(
  queue: readonly CausalQueueEvent[],
  event: CausalQueueEvent,
): boolean {
  if (!event.predecessor_id) return false;
  const predecessor = queue.find((item) => item.client_event_id === event.predecessor_id);
  return Boolean(predecessor && !isTerminalOfflineStatus(predecessor.sync_status));
}

export type RemoteSyncStatus = {
  client_event_id: string;
  sync_status: SyncStatus;
  result?: unknown;
};

export function reconcileQueueStatuses<T extends CausalQueueEvent & { result?: unknown }>(
  queue: readonly T[],
  remote: readonly RemoteSyncStatus[],
): T[] {
  const byId = new Map(remote.map((row) => [row.client_event_id, row]));
  return queue.map((event) => {
    const status = byId.get(event.client_event_id);
    if (!status) return event;
    return { ...event, sync_status: status.sync_status, result: status.result };
  });
}
