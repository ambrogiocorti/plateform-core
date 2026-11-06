import { afterEach, describe, expect, it, vi } from 'vitest';
import { publicSnapshot } from '../../src/services/public-snapshot';

afterEach(() => vi.useRealTimers());
describe('public configuration navigation cache', () => {
  it('shares one request between routes, then verifies configuration again after expiry', async () => {
    vi.useFakeTimers();
    const load = vi.fn().mockResolvedValueOnce('first').mockResolvedValueOnce('updated');
    const cache = publicSnapshot(load);
    expect(await Promise.all([cache.read(), cache.read()])).toEqual(['first', 'first']);
    expect(await cache.read()).toBe('first');
    expect(load).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(30_001);
    expect(await cache.read()).toBe('updated');
    expect(load).toHaveBeenCalledTimes(2);
  });
  it('a realtime invalidation prevents a late response from replacing a newer snapshot', async () => {
    let finishOld!: (value: string) => void;
    const load = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<string>((resolve) => {
            finishOld = resolve;
          }),
      )
      .mockResolvedValue('current');
    const cache = publicSnapshot(load);
    const old = cache.read();
    cache.invalidate();
    expect(await cache.read()).toBe('current');
    finishOld('obsolete');
    await old;
    expect(await cache.read()).toBe('current');
  });
  it('does not cache network failures', async () => {
    const load = vi.fn().mockRejectedValueOnce(new Error('network')).mockResolvedValue('recovered');
    const cache = publicSnapshot(load);
    await expect(cache.read()).rejects.toThrow('network');
    expect(await cache.read()).toBe('recovered');
  });
});
