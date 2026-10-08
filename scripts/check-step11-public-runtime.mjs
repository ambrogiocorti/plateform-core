import assert from 'node:assert/strict';
import {
  bookingVenue,
  canonicalPublicUrl,
  contrastRatio,
  normalizePublicPath,
  safeAccent,
  safeBackground,
  safePublicLink,
  selectedVenue,
  venueAwarePath,
} from '../src/services/public-site.ts';

const site = {
  name: 'Plateform Test',
  branding: {},
  content: {},
  contact: {},
  multi_venue: true,
  venues: [
    {
      id: 'c1000000-0000-4000-8000-000000000001',
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
      id: 'c1000000-0000-4000-8000-000000000002',
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

assert.equal(selectedVenue(site, '/sedi/navigli', '')?.slug, 'navigli');
assert.equal(selectedVenue(site, '/menu', '?sede=navigli')?.slug, 'navigli');
assert.equal(selectedVenue(site, '/menu', '?sede=missing')?.slug, 'centro');
assert.equal(bookingVenue(site, site.venues[0])?.slug, 'navigli');
assert.equal(venueAwarePath('/menu', site, site.venues[1]), '/menu?sede=navigli');
assert.equal(venueAwarePath('/sedi', site, site.venues[1]), '/sedi');
assert.equal(
  canonicalPublicUrl(site, '/menu', '?sede=navigli', 'https://restaurant.test'),
  'https://restaurant.test/menu?sede=navigli',
  'multi-venue canonical preserves the selected venue',
);
assert.equal(
  canonicalPublicUrl(site, '/menu', '?sede=missing', 'https://restaurant.test'),
  'https://restaurant.test/menu?sede=centro',
  'invalid venue canonical normalizes to the real fallback venue',
);
assert.equal(
  canonicalPublicUrl(site, '/sedi/navigli', '', 'https://restaurant.test'),
  'https://restaurant.test/sedi/navigli',
);
assert.equal(normalizePublicPath('/sedi/navigli'), '/sedi/:venue');
assert.equal(normalizePublicPath('/tavolo/abc'), '/tavolo/:id');
assert.equal(normalizePublicPath('/unknown'), null);
assert.ok(contrastRatio('#111315', '#f4f0e8') > 7);
assert.equal(safeBackground('#ffffff', true), undefined);
assert.equal(safeBackground('#111315', true), '#111315');
assert.equal(safeAccent('#111315', '#111315'), undefined);
assert.equal(
  safePublicLink('javascript:alert(1)', 'https://restaurant.test'),
  undefined,
  'unsafe URL schemes are rejected',
);
assert.equal(
  safePublicLink('/privacy', 'https://restaurant.test'),
  'https://restaurant.test/privacy',
);

console.log('STEP11_PUBLIC_RUNTIME_GATE=PASSED');
