import type { VenueHub } from './hub.ts';

// Hub → cloud replication of the change log (ADR-0001).
// The cloud side is public.ingest_venue_hub_batch (migration
// 20261109140000_venue_hub_cloud_ingest.sql), reached through the Edge Function
// `venue-hub-ingest`. It applies each change exactly once, only for the service
// tables of the hub's venue, and fences a hub that is no longer the promoted
// generation. This module only sends: it never decides what the cloud accepts.

export type Change = {
  seq: number;
  generation: number;
  txid: number;
  table_name: string;
  op: 'INSERT' | 'UPDATE' | 'DELETE';
  pk: Record<string, unknown>;
  row_data: Record<string, unknown> | null;
};

export type IngestBatch = { hub_id: string; generation: number; changes: Change[] };
export type IngestResult = { applied: number; quarantined: number; applied_seq: number };
export type Ingest = (batch: IngestBatch) => Promise<IngestResult>;

/** Codes that a retry cannot fix: an administrator must act. */
const TERMINAL = new Set([
  'UNAUTHORIZED',
  'HUB_REVOKED',
  'HUB_GENERATION_FENCED',
  'HUB_GENERATION_NOT_PROMOTED',
]);

export class IngestError extends Error {
  constructor(
    readonly code: string,
    readonly terminal = TERMINAL.has(code),
  ) {
    super(code);
  }
}

/**
 * Sends every pending change, in order, and acknowledges locally only what the
 * cloud confirmed. A hub transaction is never split across two batches unless
 * it alone exceeds the batch size, so the cloud does not expose half of it.
 */
export async function syncPending(hub: VenueHub, ingest: Ingest, batchSize = 200) {
  let sent = 0;
  for (;;) {
    let changes = (await hub.pendingChanges(batchSize)) as Change[];
    if (changes.length === 0) return { sent };
    if (changes.length === batchSize) {
      const lastTx = changes.at(-1)!.txid;
      const whole = changes.filter((change) => change.txid !== lastTx);
      if (whole.length > 0) changes = whole;
    }
    const last = changes.at(-1)!.seq;
    const result = await ingest({ hub_id: hub.hubId, generation: hub.generation, changes });
    if (!(result.applied_seq >= last)) throw new IngestError('INGEST_INCOMPLETE', false);
    await hub.acknowledge(last);
    sent += changes.length;
  }
}

/** HTTPS sender for the `venue-hub-ingest` Edge Function. */
export function httpIngest(url: string, secret: string, timeoutMs = 20_000): Ingest {
  return async (batch) => {
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
        body: JSON.stringify(batch),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new IngestError('CLOUD_UNREACHABLE', false);
    }
    const body = (await response.json().catch(() => null)) as
      (Partial<IngestResult> & { code?: string }) | null;
    if (!response.ok) throw new IngestError(body?.code ?? `HTTP_${response.status}`);
    if (typeof body?.applied_seq !== 'number') throw new IngestError('INVALID_RESPONSE', false);
    return body as IngestResult;
  };
}

export type SyncState = {
  status: 'IDLE' | 'SYNCING' | 'RETRYING' | 'STOPPED';
  last_success_at: string | null;
  last_error: string | null;
};

/**
 * Background loop: retries with exponential backoff while the cloud is
 * unreachable, stops on a terminal answer (revoked or fenced hub).
 */
export function startSync(
  hub: VenueHub,
  ingest: Ingest,
  options: { intervalMs?: number; maxBackoffMs?: number; onState?: (s: SyncState) => void } = {},
) {
  const interval = options.intervalMs ?? 5_000;
  const maxBackoff = options.maxBackoffMs ?? 60_000;
  const state: SyncState = { status: 'IDLE', last_success_at: null, last_error: null };
  let delay = interval;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const publish = (patch: Partial<SyncState>) => {
    Object.assign(state, patch);
    options.onState?.({ ...state });
  };
  const tick = async () => {
    if (stopped) return;
    publish({ status: 'SYNCING' });
    try {
      await syncPending(hub, ingest);
      delay = interval;
      publish({ status: 'IDLE', last_success_at: new Date().toISOString(), last_error: null });
    } catch (error) {
      const code = error instanceof IngestError ? error.code : 'SYNC_FAILED';
      if (error instanceof IngestError && error.terminal) {
        stopped = true;
        publish({ status: 'STOPPED', last_error: code });
        return;
      }
      delay = Math.min(delay * 2, maxBackoff);
      publish({ status: 'RETRYING', last_error: code });
    }
    if (!stopped) timer = setTimeout(() => void tick(), delay);
  };
  timer = setTimeout(() => void tick(), 0);
  return {
    state: () => ({ ...state }),
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
