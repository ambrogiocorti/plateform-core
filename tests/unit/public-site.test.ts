import { describe, expect, it } from 'vitest';
import {
  bookingVenue,
  resolveBookingVenue,
  publicMetricContext,
  contrastRatio,
  isClientSidePublicPath,
  normalizePublicPath,
  readableInk,
  safeAccent,
  safeBackground,
  safePublicLink,
  safeRecoveredPublicRoute,
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
  it('reserves staff and non-app URLs for native browser navigation', () => {
    expect(normalizePublicPath('/menu/carta-vini')).toBe('/menu/:slug');
    expect(isClientSidePublicPath('/menu/carta-vini')).toBe(true);
    expect(isClientSidePublicPath('/staff')).toBe(false);
    expect(isClientSidePublicPath('/staff/login')).toBe(false);
    expect(isClientSidePublicPath('/sitemap.xml')).toBe(false);
    expect(isClientSidePublicPath('/api/status')).toBe(false);
    expect(isClientSidePublicPath('/menu/../../staff')).toBe(false);
  });
  it('selects a venue from path or query without silently substituting explicit venue', () => {
    expect(selectedVenue(site, '/sedi/navigli', '')?.slug).toBe('navigli');
    expect(selectedVenue(site, '/menu', '?sede=navigli')?.slug).toBe('navigli');
    expect(selectedVenue(site, '/menu', '')?.slug).toBe('centro');
    expect(selectedVenue(site, '/menu', '?sede=missing')).toBeUndefined();
    expect(selectedVenue(site, '/menu', '?sede=')).toBeUndefined();
    expect(selectedVenue(site, '/sedi/missing', '')).toBeUndefined();
    expect(selectedVenue(site, '/sedi/navigli', '?sede=centro')).toBeUndefined();
    expect(selectedVenue(site, '/menu', '?sede=centro&sede=navigli')).toBeUndefined();
    expect(resolveBookingVenue(site, '/sedi/centro', '')).toBeUndefined();
    expect(resolveBookingVenue(site, '/sedi/navigli', '?sede=centro')).toBeUndefined();
    expect(resolveBookingVenue(site, '/prenota', '?sede=centro&sede=navigli')).toBeUndefined();
  });
  it('recovers only owned, same-origin public routes from static 404 fallback', () => {
    const origin = 'https://ristorante.example';
    expect(safeRecoveredPublicRoute('/menu/carta-vini?sede=navigli#menu', origin)).toBe(
      '/menu/carta-vini?sede=navigli#menu',
    );
    for (const candidate of [
      '//attacker.example',
      '/staff',
      '/staff/login',
      '/api/status',
      '/robots.txt',
      '/menu/../../staff',
      'https://attacker.example',
      '/non-esistente',
    ]) {
      expect(safeRecoveredPublicRoute(candidate, origin)).toBeNull();
    }
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

describe('public telemetry privacy', () => {
  it('does not retain personal or marketing query parameters in observer keys', () => {
    expect(
      publicMetricContext('/menu', '?sede=navigli&email=private@example.test&token=secret'),
    ).toEqual({ path: '/menu', key: '/menu?sede=navigli' });
    expect(publicMetricContext('/menu', '?phone=123456&utm_source=private')).toEqual({
      path: '/menu',
      key: '/menu',
    });
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
