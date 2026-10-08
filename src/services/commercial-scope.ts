/**
 * Product boundary for the initial cash/POS + browser/PDF commercial edition.
 * Provider payments and Epson drivers require a separately certified release.
 * This is presentation gating only: database licensing must also deny access.
 */
export const externalPaymentProvidersIncluded = false;
export const epsonPrintingIncluded = false;

export function permittedPaymentMethod(method: string): boolean {
  return method === 'CASH' || method === 'CARD_POS' ||
    (externalPaymentProvidersIncluded && ['STRIPE', 'SATISPAY_API', 'SATISPAY_POS'].includes(method));
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
  return !externalPaymentProvidersIncluded &&
    (slot.status_if_booked === 'PENDING_DEPOSIT' || slot.deposit != null);
}

export function permittedBookingSlots<T extends CoreBookingSlot>(slots: readonly T[]): T[] {
  return externalPaymentProvidersIncluded
    ? [...slots]
    : slots.filter((slot) =>
      (slot.status_if_booked === 'RESERVED' || slot.status_if_booked === 'REQUESTED') &&
      !requiresExcludedDeposit(slot),
    );
}