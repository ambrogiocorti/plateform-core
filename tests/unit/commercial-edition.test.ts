import { describe, expect, it, vi, afterEach } from 'vitest';
import { commercialScopeForEdition } from '../../shared/commercial-edition';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});
describe('explicit commercial edition', () => {
  it.each([undefined, null, '', 'core', 'full', 'UNKNOWN', {}, true])(
    'fails closed for unconfigured or invalid edition %j',
    (edition) => {
      expect(commercialScopeForEdition(edition)).toEqual({
        edition: 'CORE',
        externalPaymentProvidersIncluded: false,
        epsonPrintingIncluded: false,
      });
    },
  );
  it('enables FULL integrations only for the exact configured value', () => {
    expect(commercialScopeForEdition('FULL')).toEqual({
      edition: 'FULL',
      externalPaymentProvidersIncluded: true,
      epsonPrintingIncluded: true,
    });
    expect(Object.isFrozen(commercialScopeForEdition('FULL'))).toBe(true);
  });
  it('keeps CORE browser and manual payments available', async () => {
    vi.stubEnv('VITE_PLATEFORM_EDITION', 'CORE');
    const scope = await import('../../src/services/commercial-scope');
    expect(scope.permittedPaymentMethods(['CASH', 'CARD_POS', 'STRIPE', 'SATISPAY_API'])).toEqual([
      'CASH',
      'CARD_POS',
    ]);
    expect(scope.permittedPrintDrivers()).toEqual(['BROWSER']);
  });
  it('exposes configured FULL providers, signed bridge printing and known deposit slots', async () => {
    vi.stubEnv('VITE_PLATEFORM_EDITION', 'FULL');
    const scope = await import('../../src/services/commercial-scope');
    expect(
      scope.permittedPaymentMethods(['CASH', 'CARD_POS', 'STRIPE', 'SATISPAY_API', 'BOGUS']),
    ).toEqual(['CASH', 'CARD_POS', 'STRIPE', 'SATISPAY_API']);
    expect(scope.permittedPrintDrivers()).toEqual(['BROWSER', 'EPOS', 'BRIDGE']);
    expect(
      scope.permittedBookingSlots([
        { status_if_booked: 'PENDING_DEPOSIT' },
        { status_if_booked: 'UNKNOWN' },
        {},
      ]),
    ).toEqual([{ status_if_booked: 'PENDING_DEPOSIT' }]);
  });
});
