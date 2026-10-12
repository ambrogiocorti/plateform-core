import { chunkClientEventIds, type CausalQueueEvent } from './queue-causality.ts';
import {
  hasBlockingPredecessor,
  reconcileQueueStatuses,
  type RemoteSyncStatus,
} from './queue-policy.ts';

export async function reconcileOfflineEvents<T extends CausalQueueEvent>(
  events: T[],
  userId: string,
  fetchStatuses: (venueId: string, clientEventIds: string[]) => Promise<RemoteSyncStatus[]>,
  persist: () => Promise<void>,
): Promise<boolean> {
  const venues = [
    ...new Set(events.filter((event) => event.user_id === userId).map((event) => event.venue_id)),
  ];
  let changed = false;
  for (const venue of venues)
    for (const clientEvents of chunkClientEventIds(events, userId, venue)) {
      const statuses = await fetchStatuses(venue, clientEvents);
      const reconciled = reconcileQueueStatuses(events, statuses);
      if (
        reconciled.some(
          (event, index) =>
            event.sync_status !== events[index]?.sync_status ||
            event.result !== events[index]?.result,
        )
      ) {
        events.splice(0, events.length, ...reconciled);
        changed = true;
      }
    }
  if (changed) await persist();
  return changed;
}

export async function replayOfflineEvents<T extends CausalQueueEvent>(
  events: T[],
  userId: string,
  syncEvent: (event: T) => Promise<RemoteSyncStatus>,
  persist: () => Promise<void>,
): Promise<number> {
  let replayed = 0;
  for (const event of events) {
    if (event.sync_status !== 'PENDING' || event.user_id !== userId) continue;
    if (hasBlockingPredecessor(events, event)) continue;
    const result = await syncEvent(event);
    event.sync_status = result.sync_status;
    event.result = result.result;
    replayed += 1;
    await persist();
  }
  return replayed;
}
