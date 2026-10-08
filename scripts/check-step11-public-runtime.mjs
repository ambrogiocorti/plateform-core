import assert from 'node:assert/strict';
import {
  bookingVenue,
  canonicalPublicUrl,
  contrastRatio,
  isClientSidePublicPath,
  normalizePublicPath,
  publicMetricContext,
  readableInk,
  resolveBookingVenue,
  safeRecoveredPublicRoute,
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
assert.equal(selectedVenue(site, '/menu', '')?.slug, 'centro', 'generic menu uses the default venue');
assert.equal(selectedVenue(site, '/menu', '?sede=missing'), undefined,
  'unknown explicit venue must not display default-venue prices');
assert.equal(selectedVenue(site, '/menu', '?sede='), undefined,
  'empty explicit venue must not display default-venue prices');
assert.equal(selectedVenue(site, '/sedi/missing', ''), undefined,
  'unknown venue detail must not inherit another venue');
assert.equal(bookingVenue(site, site.venues[0])?.slug, 'navigli');
assert.equal(resolveBookingVenue(site, '/', '')?.slug, 'navigli', 'generic booking finds available venue');
assert.equal(resolveBookingVenue(site, '/prenota', '?sede=navigli')?.slug, 'navigli');
assert.equal(resolveBookingVenue(site, '/prenota', '?sede=centro'), undefined,
  'disabled explicitly selected venue is never silently replaced');
assert.equal(resolveBookingVenue(site, '/prenota', '?sede=missing'), undefined,
  'unknown explicitly selected venue must fail closed');
assert.equal(resolveBookingVenue(site, '/prenota', '?sede='), undefined,
  'empty explicit selection must fail closed');
assert.equal(resolveBookingVenue({...site,venues:site.venues.map(v=>({...v,reservations_enabled:false}))},'/prenota',''),undefined);
assert.equal(venueAwarePath('/menu', site, site.venues[1]), '/menu?sede=navigli');
assert.equal(venueAwarePath('/sedi', site, site.venues[1]), '/sedi');
assert.equal(
  canonicalPublicUrl(site, '/menu', '?sede=navigli', 'https://restaurant.test'),
  'https://restaurant.test/menu?sede=navigli',
  'multi-venue canonical preserves the selected venue',
);
assert.equal(
  canonicalPublicUrl(site, '/menu/carta-vini', '?sede=navigli', 'https://restaurant.test'),
  'https://restaurant.test/menu/carta-vini?sede=navigli',
  'published menu canonical preserves the authorized venue context',
);
assert.equal(
  canonicalPublicUrl(site, '/menu/carta-vini', '?sede=centro', 'https://restaurant.test'),
  'https://restaurant.test/menu/carta-vini?sede=centro',
  'different venue published menu retains its own canonical',
);
assert.equal(
  canonicalPublicUrl(site, '/menu', '?sede=missing', 'https://restaurant.test'),
  'https://restaurant.test/menu',
  'invalid venue canonical must not falsely attribute prices to the default venue',
);
assert.equal(safeRecoveredPublicRoute('/menu/carta-vini?sede=navigli#lista', 'https://restaurant.test'),
  '/menu/carta-vini?sede=navigli#lista');
for (const forged of ['//attacker.example/', '/staff', '/staff/login', '/api/status',
  '/sitemap.xml', '/unknown', 'https://attacker.example/', '/menu/../../staff']) {
  assert.equal(safeRecoveredPublicRoute(forged, 'https://restaurant.test'), null,
    `static 404 route recovery rejects ${forged}`);
}
assert.equal(
  canonicalPublicUrl(site, '/sedi/navigli', '', 'https://restaurant.test'),
  'https://restaurant.test/sedi/navigli',
);
assert.equal(normalizePublicPath('/sedi/navigli'), '/sedi/:venue');
assert.equal(normalizePublicPath('/menu/carta-vini'), '/menu/:slug');
assert.equal(normalizePublicPath('/tavolo/abc'), '/tavolo/:id');
assert.equal(normalizePublicPath('/unknown'), null);
assert.deepEqual(publicMetricContext('/menu/carta-vini', '?sede=navigli'), {
  path: '/menu/:slug', key: '/menu/carta-vini?sede=navigli',
}, 'performance metrics use a stable, venue-specific route snapshot');
assert.equal(publicMetricContext('/tavolo/private-customer-token', '?sede=navigli'), null,
  'QR/customer URLs must not be recorded in public page telemetry');
assert.equal(publicMetricContext('/staff/login', ''), null,
  'staff URLs must never be counted as public routes');
for (const route of ['/', '/menu', '/menu/carta-vini', '/sedi/navigli', '/tavolo/abc', '/prenota']) {
  assert.equal(isClientSidePublicPath(route), true, `public route: ${route}`);
}
for (const route of ['/staff', '/staff/login', '/api/status', '/sitemap.xml',
  '/robots.txt', '/menu/../../staff', '/menu/', '/sedi/milano/extra', '/unknown']) {
  assert.equal(isClientSidePublicPath(route), false, `not a public SPA route: ${route}`);
}
assert.ok(contrastRatio('#111315', '#f4f0e8') > 7);
assert.equal(safeBackground('#ffffff', true), undefined);
assert.equal(safeBackground('#111315', true), '#111315');
assert.equal(safeAccent('#111315', '#111315'), undefined);
for (const color of ['#ffffff','#ff0000','#ff6600','#00a0f0','#22cc99','#795127','#d3ab78']) {
  assert.ok(contrastRatio(color,readableInk(color)) >= 4.5, `button text contrast: ${color}`);
}
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
