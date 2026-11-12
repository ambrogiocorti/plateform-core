import { z } from 'zod';
import { client } from '../api/client';
import { SnapshotReconciler } from './reconcile';

export type ConnectionState = 'CONNECTING' | 'LIVE' | 'DEGRADED' | 'OFFLINE';
const signalSchema = z.object({ id: z.uuid(), topic: z.string() });
export interface LiveOptions {
  venueId: string | null;
  userId?: string;
  topics: readonly string[];
  refresh: () => Promise<void>;
  accessChanged?: (signaled: boolean) => Promise<void>;
  state: (state: ConnectionState) => void;
}

export function watchLive(options: LiveOptions): () => void {
  let connected = false;
  let disposed = false;
  const state = (value: ConnectionState) => {
    if (!disposed) options.state(value);
  };
  const reconciler = new SnapshotReconciler(
    async () => {
      await options.refresh();
      state(navigator.onLine ? (connected ? 'LIVE' : 'DEGRADED') : 'OFFLINE');
    },
    () => state(navigator.onLine ? 'DEGRADED' : 'OFFLINE'),
  );
  let accessInvalidated = false;
  const access = new SnapshotReconciler(
    async () => {
      const signaled = accessInvalidated;
      accessInvalidated = false;
      await options.accessChanged?.(signaled);
    },
    () => state('DEGRADED'),
    0,
  );
  const channel = client().channel(`plateform:${crypto.randomUUID()}`);
  const receive = (payload: { new: Record<string, unknown> }) => {
    const parsed = signalSchema.safeParse(payload.new);
    if (!parsed.success) {
      reconciler.invalidate();
      return;
    }
    if (parsed.data.topic === 'ACCESS') {
      accessInvalidated = true;
      access.invalidate(parsed.data.id);
    } else if (options.topics.includes(parsed.data.topic)) reconciler.invalidate(parsed.data.id);
  };
  if (options.venueId)
    channel.on(
      'postgres_changes',
      {
        event: 'INSERT',
        schema: 'public',
        table: 'realtime_signals',
        filter: `venue_id=eq.${options.venueId}`,
      },
      receive,
    );
  if (options.userId)
    channel.on(
      'postgres_changes',
      {
        event: 'INSERT',
        schema: 'public',
        table: 'realtime_signals',
        filter: `recipient_user_id=eq.${options.userId}`,
      },
      receive,
    );
  state(navigator.onLine ? 'CONNECTING' : 'OFFLINE');
  channel.subscribe((status) => {
    connected = status === 'SUBSCRIBED';
    if (connected) {
      reconciler.invalidate();
      access.invalidate();
    } else state(navigator.onLine ? 'DEGRADED' : 'OFFLINE');
  });
  // Polling and focus reconciliation also recover from missed events and expired/revoked sessions.
  const interval = setInterval(() => {
    if (document.visibilityState === 'visible') {
      reconciler.invalidate();
      access.invalidate();
    }
  }, 30_000);
  const online = () => {
    state('CONNECTING');
    reconciler.invalidate();
    access.invalidate();
  };
  const offline = () => state('OFFLINE');
  const focus = () => {
    if (document.visibilityState === 'visible') {
      reconciler.invalidate();
      access.invalidate();
    }
  };
  window.addEventListener('online', online);
  window.addEventListener('offline', offline);
  document.addEventListener('visibilitychange', focus);
  return () => {
    disposed = true;
    reconciler.dispose();
    access.dispose();
    clearInterval(interval);
    window.removeEventListener('online', online);
    window.removeEventListener('offline', offline);
    document.removeEventListener('visibilitychange', focus);
    void client().removeChannel(channel);
  };
}
