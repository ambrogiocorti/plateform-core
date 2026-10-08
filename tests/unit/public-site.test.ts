import { describe, expect, it } from 'vitest';
import {
  bookingVenue,
  contrastRatio,
  readableInk,
  safeAccent,
  safeBackground,
  safePublicLink,
  selectedVenue,
  venueAwarePath,
} from '../../src/services/public-site';
import type { PublicSite } from '../../src/types/domain';

const site: PublicSite = {
  name: 'Plateform Test',
  branding: {},
  content: {},
  contact: {},
  multi_venue: true,
  venues: [
    {
      id: '00000000-0000-4000-8000-000000000001',
      name: 'Centro',
      slug: 'centro',
      address: 'Via 1',
      phone: '+3901',
      email: null,
      opening_hours: {},
      timezone: 'Europe/Rome',
      currency: 'EUR',
      locale: 'it-IT',
      reservations_enabled: false,
    },
    {
      id: '00000000-0000-4000-8000-000000000002',
      name: 'Navigli',
      slug: 'navigli',
      address: 'Via 2',
      phone: '+3902',
      email: null,
      opening_hours: {},
      timezone: 'Europe/Rome',
      currency: 'EUR',
      locale: 'it-IT',
      reservations_enabled: true,
    },
  ],
};

describe('public site venue routing', () => {
  it('selects a venue from path or query and falls back safely', () => {
    expect(selectedVenue(site, '/sedi/navigli', '')?.slug).toBe('navigli');
    expect(selectedVenue(site, '/menu', '?sede=navigli')?.slug).toBe('navigli');
    expect(selectedVenue(site, '/menu', '?sede=missing')?.slug).toBe('centro');
  });
  it('selects the first bookable venue instead of a disabled default', () => {
    expect(bookingVenue(site, site.venues[0])?.slug).toBe('navigli');
    expect(bookingVenue(site, site.venues[1])?.slug).toBe('navigli');
  });
  it('preserves venue context across public pages', () => {
    expect(venueAwarePath('/menu', site, site.venues[1])).toBe('/menu?sede=navigli');
    expect(venueAwarePath('/sedi', site, site.venues[1])).toBe('/sedi');
  });
});

describe('public branding contrast', () => {
  it('chooses readable ink and rejects inaccessible backgrounds', () => {
    expect(readableInk('#f4f0e8')).toBe('#111315');
    expect(readableInk('#111315')).toBe('#fffdf8');
    expect(contrastRatio('#111315', '#f4f0e8')).toBeGreaterThan(7);
    expect(safeBackground('#ffffff', true)).toBeUndefined();
    expect(safeBackground('#111315', true)).toBe('#111315');
    expect(safeAccent('#b88a55', '#111315')).toBe('#b88a55');
    expect(safeAccent('#111315', '#111315')).toBeUndefined();
  });
});

describe('public link safety', () => {
  it('accepts https and same-origin http while rejecting script schemes', () => {
    expect(safePublicLink('https://instagram.com/test', 'https://restaurant.test')).toBe(
      'https://instagram.com/test',
    );
    expect(safePublicLink('/privacy', 'https://restaurant.test')).toBe(
      'https://restaurant.test/privacy',
    );
    expect(safePublicLink('javascript:alert(1)', 'https://restaurant.test')).toBeUndefined();
    expect(safePublicLink('http://evil.test', 'https://restaurant.test')).toBeUndefined();
  });
});
