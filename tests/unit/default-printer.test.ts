import { describe, expect, it } from 'vitest';
import { automaticReceiptPrinter, type ReceiptPrinter } from '../../src/printing/default-printer';

const printer = (driver: ReceiptPrinter['driver'], isDefault = false): ReceiptPrinter => ({
  driver,
  configuration: { default_for_receipts: isDefault },
});

describe('cross-platform receipt printer selection', () => {
  it('directly selects one Epson ePOS Ethernet printer without a browser dialog', () => {
    const epos = printer('EPOS');
    expect(automaticReceiptPrinter([epos])).toBe(epos);
  });
  it('directly selects one signed bridge independent of client operating system', () => {
    const bridge = printer('BRIDGE');
    expect(automaticReceiptPrinter([bridge])).toBe(bridge);
  });
  it('retains the browser dialog for browser/PDF printing', () => {
    expect(automaticReceiptPrinter([printer('BROWSER')])).toBeNull();
  });
  it('requires an unambiguous default with multiple devices', () => {
    const epos = printer('EPOS', true);
    const bridge = printer('BRIDGE');
    expect(automaticReceiptPrinter([epos, bridge, printer('BROWSER')])).toBe(epos);
    expect(automaticReceiptPrinter([epos, printer('BRIDGE', true)])).toBeNull();
    expect(automaticReceiptPrinter([printer('EPOS'), bridge])).toBeNull();
  });
});
