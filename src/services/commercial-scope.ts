/**
 * Product boundary for the first commercial edition: cash, external POS, Stripe and Satispay
 * (provider payments since the 2026-10-19 decision) and browser/PDF printing. Providers still
 * need the installation licence and the venue's keys: the database refuses unlicensed methods
 * (20261019100000_payment_providers_by_license.sql). Online booking deposits and Epson drivers
 * stay outside the edition. This is presentation gating only.
 */
export const externalPaymentProvidersIncluded = true;
/** No Edge Function collects deposits yet (`reservation-deposit` does not exist). */
export const onlineBookingDepositsIncluded = false;
export const epsonPrintingIncluded = false;

export function permittedPaymentMethod(method: string): boolean {
  return (
    method === 'CASH' ||
    method === 'CARD_POS' ||
    (externalPaymentProvidersIncluded &&
      ['STRIPE', 'SATISPAY_API', 'SATISPAY_POS'].includes(method))
  );
}

export function permittedPaymentMethods(methods: readonly string[]): string[] {
  return methods.filter(permittedPaymentMethod);
}

export function permittedPrintDriver(driver: string): boolean {
  return driver === 'BROWSER' || (epsonPrintingIncluded && ['EPOS', 'BRIDGE'].includes(driver));
}

export function permittedPrintDrivers(): string[] {
  return epsonPrintingIncluded ? ['BROWSER', 'EPOS', 'BRIDGE'] : ['BROWSER'];
}

/** Do not offer a reservation slot whose only payment path is excluded. */
export type CoreBookingSlot = { status_if_booked?: string; deposit?: unknown };

/** A deposit object is authoritative evidence that a slot may require online payment,
 * even when a legacy or inconsistent API response labels it RESERVED/REQUESTED.
 * Unknown booking statuses must fail closed in the CORE edition.
 */
export function requiresExcludedDeposit(slot: CoreBookingSlot): boolean {
  return (
    !onlineBookingDepositsIncluded &&
    (slot.status_if_booked === 'PENDING_DEPOSIT' || slot.deposit != null)
  );
}

export function permittedBookingSlots<T extends CoreBookingSlot>(slots: readonly T[]): T[] {
  return onlineBookingDepositsIncluded
    ? [...slots]
    : slots.filter(
        (slot) =>
          (slot.status_if_booked === 'RESERVED' || slot.status_if_booked === 'REQUESTED') &&
          !requiresExcludedDeposit(slot),
      );
}
