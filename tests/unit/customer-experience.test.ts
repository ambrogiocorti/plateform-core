import { afterEach, describe, expect, it, vi } from 'vitest';
import { preferredPublicTheme, savePublicTheme } from '../../src/services/public-theme';
import { readGuestFavorites, writeGuestFavorites } from '../../src/services/customer-favorites';

function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('public restaurant theme', () => {
  it('starts in accessible light mode and persists a guest-selected dark theme', () => {
    const localStorage = storage();
    const root = { dataset: {} as Record<string, string> };
    vi.stubGlobal('localStorage', localStorage);
    vi.stubGlobal('document', { documentElement: root });
    expect(preferredPublicTheme()).toBe('light');
    savePublicTheme('dark');
    expect(root.dataset.theme).toBe('dark');
    expect(preferredPublicTheme()).toBe('dark');
    savePublicTheme('light');
    expect(preferredPublicTheme()).toBe('light');
  });

  it('fails safely when private browsing denies persistence', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    });
    const root = { dataset: {} as Record<string, string> };
    vi.stubGlobal('document', { documentElement: root });
    expect(preferredPublicTheme()).toBe('light');
    expect(() => savePublicTheme('dark')).not.toThrow();
    expect(root.dataset.theme).toBe('dark');
  });
});

describe('guest favorites', () => {
  const venueA = '10000000-0000-4000-8000-000000000001';
  const venueB = '10000000-0000-4000-8000-000000000002';
  const dish = '40000000-0000-4000-8000-000000000007';

  it('stays isolated by restaurant and does not require an identity', () => {
    vi.stubGlobal('localStorage', storage());
    expect(writeGuestFavorites(venueA, new Set([dish]))).toBe(true);
    expect(readGuestFavorites(venueA)).toEqual(new Set([dish]));
    expect(readGuestFavorites(venueB)).toEqual(new Set());
  });

  it('ignores malformed persisted content and inaccessible storage', () => {
    const memory = storage();
    memory.setItem(`plateform-guest-favorites:${venueA}`, '["not-a-uuid", 42]');
    vi.stubGlobal('localStorage', memory);
    expect(readGuestFavorites(venueA)).toEqual(new Set());
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    });
    expect(readGuestFavorites(venueA)).toEqual(new Set());
    expect(writeGuestFavorites(venueA, new Set([dish]))).toBe(false);
  });
});
