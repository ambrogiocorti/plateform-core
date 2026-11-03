import { describe, expect, it } from 'vitest';
import { eposDocument, type PrintPayload } from '../../shared/print-document';
import { usbEscPosDocument } from '../../tools/print-bridge/usb-print';

const sample: PrintPayload = {
  restaurant: 'Caffè & Cucina',
  at: '2026-11-03T11:00:00Z',
  account: 'test-account',
  table: '12',
  document: 'Ricevuta di cortesia',
  lines: [{ name: 'Pasta × 2', quantity: 1, total_cents: 1250 }],
  balance: { total_cents: 1250, discount_cents: 0 },
};

describe('Epson TM-T20III USB ESC/POS encoding', () => {
  it('converts the signed ePOS template to non-fiscal printable ASCII and automatic cut', () => {
    const bytes = usbEscPosDocument(eposDocument(sample));
    expect([...bytes.subarray(0, 2)]).toEqual([0x1b, 0x40]);
    expect([...bytes.subarray(-5)]).toEqual([0x0a, 0x0a, 0x1d, 0x56, 0x01]);
    const text = bytes.subarray(2, -5).toString('ascii');
    expect(text).toContain('Caffe & Cucina');
    expect(text).toContain('Pasta x 2');
    expect(text).toContain('DOCUMENTO NON FISCALE');
    expect(text).toContain('EUR');
  });

  it('never passes injected control bytes through to the printer', () => {
    const receipt = eposDocument({
      ...sample,
      restaurant: 'Test\u001b@\u001dV\u0000\t',
      lines: [{ name: 'Café\u001b', quantity: 1 }],
    });
    const bytes = usbEscPosDocument(receipt);
    const documentBytes = bytes.subarray(2, -5);
    expect(documentBytes.includes(0x1b)).toBe(false);
    expect(documentBytes.includes(0x1d)).toBe(false);
    expect(documentBytes.includes(0x00)).toBe(false);
    expect(documentBytes.toString('ascii')).toContain('Cafe?');
  });

  it('rejects foreign XML commands, unknown entities and modified templates', () => {
    const document = eposDocument(sample);
    for (const value of [
      document.replace('<cut type="feed"/>', '<cut type="full"/>'),
      document.replace('<text lang="it"/>', '<image/>'),
      document.replace('&amp;', '&unsafe;'),
      document + '<text>extra</text>',
      '<!DOCTYPE receipt>' + document,
    ]) {
      expect(() => usbEscPosDocument(value)).toThrow('UNSUPPORTED_EPSON_DOCUMENT');
    }
  });

  it('wraps every line to fit thermal paper and refuses oversized jobs', () => {
    const bytes = usbEscPosDocument(eposDocument({ ...sample, restaurant: 'A'.repeat(200) }));
    const lines = bytes.subarray(2, -5).toString('ascii').split('\n');
    expect(lines.every((line) => line.length <= 42)).toBe(true);
    expect(() =>
      usbEscPosDocument(eposDocument({ ...sample, restaurant: 'A'.repeat(70000) })),
    ).toThrow('PRINT_PAYLOAD_TOO_LARGE');
  });
});
