import { describe, expect, it } from 'vitest';
import {
  readWaitlistOfferFragment,
  waitlistAcceptResponse,
  waitlistCreateResponse,
  waitlistOfferFragment,
  waitlistServiceTimes,
} from '../../src/services/waitlist';
import {
  isClientSidePublicPath,
  publicMetricContext,
  safeRecoveredPublicRoute,
} from '../../src/services/public-site';

const entry = '00000000-0000-4000-8000-000000000001';
const token = 'a'.repeat(64);

describe('waitlist confidential acceptance link', () => {
  it('stores the one-use token in a fragment, never in search parameters', () => {
    const fragment = waitlistOfferFragment(entry, token);
    const url = new URL(`/lista-attesa/offerta${fragment}`, 'https://ristorante.example');
    expect(url.search).toBe('');
    expect(url.hash).toBe(fragment);
    expect(readWaitlistOfferFragment(url.hash)).toEqual({ entry, token });
  });

  it('rejects forged, duplicate, malformed and oversized link fragments', () => {
    for (const candidate of [
      '',
      '#token=abc',
      '#entry=foo&token=bar',
      `#entry=${entry}&token=${token}&token=${token}`,
      `#entry=${entry}&entry=${entry}&token=${token}`,
      `#entry=${entry}&token=${'g'.repeat(64)}`,
      `#entry=${entry}&token=${'a'.repeat(601)}`,
    ])
      expect(readWaitlistOfferFragment(candidate)).toBeNull();
    expect(() => waitlistOfferFragment(entry, 'x')).toThrow('INVALID_WAITLIST_LINK');
  });

  it('registers deep links on the public app while suppressing offer telemetry', () => {
    expect(isClientSidePublicPath('/lista-attesa')).toBe(true);
    expect(isClientSidePublicPath('/lista-attesa/offerta')).toBe(true);
    expect(publicMetricContext('/lista-attesa/offerta', `?token=${token}`)).toBeNull();
    expect(publicMetricContext('/lista-attesa', `?sede=navigli&token=${token}`)).toEqual({
      path: '/lista-attesa',
      key: '/lista-attesa?sede=navigli',
    });
    expect(
      safeRecoveredPublicRoute(
        `/lista-attesa/offerta#entry=${entry}&token=${token}`,
        'https://ristorante.example',
      ),
    ).toBe(`/lista-attesa/offerta#entry=${entry}&token=${token}`);
  });
});

describe('waitlist validated service time choices', () => {
  it('produces discrete, ordered slots without offering the service close time', () => {
    expect(waitlistServiceTimes('12:00:00', '13:30:00', 30)).toEqual(['12:00', '12:30', '13:00']);
    expect(waitlistServiceTimes('22:30:00', '01:00:00', 30)).toEqual([
      '22:30',
      '23:00',
      '23:30',
      '00:00',
      '00:30',
    ]);
  });

  it('rejects invalid or unusually dense schedules', () => {
    expect(waitlistServiceTimes('99:00', '12:00', 30)).toEqual([]);
    expect(waitlistServiceTimes('12:00', '13:00', 0)).toEqual([]);
    expect(waitlistServiceTimes('12:00', '13:00', 2.5)).toEqual([]);
    expect(waitlistServiceTimes('12:00', '13:00', 241)).toEqual([]);
  });
});

describe('waitlist authoritative results', () => {
  it('does not treat a waiting entry as a booked reservation', () => {
    expect(
      waitlistCreateResponse.parse({
        id: entry,
        status: 'WAITING',
        service_date: '2026-11-01',
        preferred_start_time: '19:00:00',
        preferred_end_time: null,
      }).status,
    ).toBe('WAITING');
    expect(
      waitlistAcceptResponse.safeParse({
        entry_id: entry,
        status: 'WAITING',
        reservation_id: entry,
        reservation_status: 'RESERVED',
        offered_time: '19:00:00',
        deposit: null,
      }).success,
    ).toBe(false);
  });
});
