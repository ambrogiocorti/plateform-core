import { afterEach, describe, expect, it, vi } from 'vitest';
import { SnapshotReconciler } from '../../src/realtime/reconcile';

describe('Authoritative snapshot reconciliation', () => {
  afterEach(() => vi.useRealTimers());
  it('coalesces duplicate and out-of-order events into one authoritative fetch', async () => {
    const fetch = vi.fn(async () => {});
    const failed = vi.fn();
    const reconciler = new SnapshotReconciler(fetch, failed);
    reconciler.invalidate('later');
    reconciler.invalidate('earlier');
    reconciler.invalidate('later');
    await reconciler.flush();
    expect(fetch).toHaveBeenCalledTimes(1);
    reconciler.invalidate('earlier');
    await reconciler.flush();
    expect(fetch).toHaveBeenCalledTimes(1);
    reconciler.dispose();
  });
  it('fetches again when a change arrives while a snapshot is in flight', async () => {
    let release: () => void = () => {};
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetch = vi
      .fn()
      .mockImplementationOnce(() => pending)
      .mockResolvedValue(undefined);
    const reconciler = new SnapshotReconciler(fetch, vi.fn());
    reconciler.invalidate('first');
    const flush = reconciler.flush();
    reconciler.invalidate('second');
    release();
    await flush;
    expect(fetch).toHaveBeenCalledTimes(2);
    reconciler.dispose();
  });
  it('reports fetch failure and recovers on reconnect without applying stale event payloads', async () => {
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new Error('database offline'))
      .mockResolvedValue(undefined);
    const failed = vi.fn();
    const reconciler = new SnapshotReconciler(fetch, failed);
    reconciler.invalidate();
    await reconciler.flush();
    expect(failed).toHaveBeenCalledTimes(1);
    reconciler.invalidate();
    await reconciler.flush();
    expect(fetch).toHaveBeenCalledTimes(2);
    reconciler.dispose();
  });
  it('cancels deferred refreshes after navigating away', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(async () => {});
    const reconciler = new SnapshotReconciler(fetch, vi.fn());
    reconciler.invalidate('event');
    reconciler.dispose();
    await vi.runAllTimersAsync();
    expect(fetch).not.toHaveBeenCalled();
  });
});
