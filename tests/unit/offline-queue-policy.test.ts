import { describe, expect, it } from 'vitest';
import {
  hasBlockingPredecessor,
  isTerminalOfflineStatus,
  predecessorFor,
  reconcileQueueStatuses,
  type CausalQueueEvent,
} from '../../src/offline/queue-policy';

const base = (id: string, status: CausalQueueEvent['sync_status']): CausalQueueEvent => ({
  client_event_id: id,
  user_id: '20000000-0000-4000-8000-000000000004',
  venue_id: '10000000-0000-4000-8000-000000000001',
  resource_id: crypto.randomUUID(),
  sync_status: status,
  predecessor_id: null,
});

describe('offline causal queue policy', () => {
  it('treats server terminal outcomes as causal completion', () => {
    expect(isTerminalOfflineStatus('SYNCED')).toBe(true);
    expect(isTerminalOfflineStatus('REJECTED')).toBe(true);
    expect(isTerminalOfflineStatus('RESOLVED')).toBe(true);
    expect(isTerminalOfflineStatus('CONFLICT')).toBe(false);
  });

  it('links a new event to the latest unfinished event for the same user and venue', () => {
    const queue = [base(crypto.randomUUID(), 'SYNCED'), base(crypto.randomUUID(), 'CONFLICT')];
    expect(predecessorFor(queue, queue[1]!)).toBe(queue[1]!.client_event_id);
  });

  it('does not block a successor after its predecessor becomes rejected', () => {
    const predecessor = base(crypto.randomUUID(), 'REJECTED');
    const successor = { ...base(crypto.randomUUID(), 'PENDING'), predecessor_id: predecessor.client_event_id };
    expect(hasBlockingPredecessor([predecessor, successor], successor)).toBe(false);
  });

  it('reconciles local conflict state with the authoritative server terminal state', () => {
    const event = { ...base(crypto.randomUUID(), 'CONFLICT'), result: { reason: 'VERSION_CONFLICT' } };
    const reconciled = reconcileQueueStatuses([event], [
      { client_event_id: event.client_event_id, sync_status: 'REJECTED', result: { action: 'DISCARD' } },
    ]);
    expect(reconciled[0]!.sync_status).toBe('REJECTED');
    expect(reconciled[0]!.result).toEqual({ action: 'DISCARD' });
  });
});
