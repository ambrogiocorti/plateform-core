export interface ReceiptPrinter {
  driver: 'BROWSER' | 'EPOS' | 'BRIDGE';
  configuration: Record<string, unknown>;
}

// If a venue has several devices, select only an explicitly configured
// default. Ambiguous defaults fail closed to the existing manual chooser.
export function automaticReceiptPrinter<T extends ReceiptPrinter>(
  devices: readonly T[],
): T | null {
  const direct = (device: T) => device.driver === 'EPOS' || device.driver === 'BRIDGE';
  const defaults = devices.filter(
    (device) => direct(device) && device.configuration.default_for_receipts === true,
  );
  if (defaults.length === 1) return defaults[0] ?? null;
  if (defaults.length > 1) return null;
  return devices.length === 1 && devices[0] && direct(devices[0]) ? devices[0] : null;
}
