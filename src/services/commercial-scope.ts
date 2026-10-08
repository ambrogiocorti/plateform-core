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