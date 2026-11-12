/** Build/runtime capability boundary. This never grants a database licence. */
export function commercialScopeForEdition(edition: unknown) {
  const full = edition === 'FULL';
  return Object.freeze({
    edition: full ? ('FULL' as const) : ('CORE' as const),
    externalPaymentProvidersIncluded: full,
    epsonPrintingIncluded: full,
  });
}
