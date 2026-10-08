import { describe, it, expect } from 'vitest';
import { eposDocument, printerEndpoint, printLines } from '../../src/printing/document';
import { isPdfOutput } from '../../src/printing/invoice';
const payload = {
  restaurant: 'Test & Brand',
  at: '2026-10-02T20:00:00Z',
  account: 'A',
  table: '1',
  document: 'DOCUMENTO NON FISCALE',
  lines: [
    {
      name: '<cut type="feed"/>',
      quantity: 2,
      total_cents: 1001,
      removed: ['A & B'],
      variants: [{ group: 'Cottura', option: 'Al sangue' }],
    },
  ],
  balance: { total_cents: 1001, discount_cents: 0 },
  payments: [{ method: 'CASH', amount_cents: 1001, tip_cents: 200 }],
  refunds: [{ method: 'CASH', amount_cents: 300 }],
};
describe('printing protocol boundary', () => {
  it('escapes every product text before composing printer commands', () => {
    const xml = eposDocument(payload);
    expect(xml).toContain('&lt;cut type=&quot;feed&quot;/&gt;');
    expect(xml.match(/<cut /g)).toHaveLength(1);
    expect(xml).toContain('A &amp; B');
  });
  it('prints total and tip as distinct amounts', () => {
    const lines = printLines(payload);
    expect(lines).toContain('Totale: 10,01 €');
    expect(lines).toContain('Mancia separata: 2,00 €');
    expect(lines).toContain('Rimborso CASH: -3,00 €');
    expect(lines).toContain('DOCUMENTO NON FISCALE');
    expect(lines).toContain('Non costituisce fattura elettronica né documento commerciale fiscale.');
  });
  it('distinguishes the managed PDF/browser output from a normal browser printer', () => {
    expect(isPdfOutput({ output: 'PDF', paper: 'A4' })).toBe(true);
    expect(isPdfOutput({ output: 'THERMAL' })).toBe(false);
    expect(isPdfOutput(undefined)).toBe(false);
  });
  it('rejects endpoint credentials, plaintext transport and unrelated paths', () => {
    expect(() =>
      printerEndpoint('http://printer.local/cgi-bin/epos/service.cgi', 'EPOS'),
    ).toThrow();
    expect(() =>
      printerEndpoint('https://u:p@printer.local/cgi-bin/epos/service.cgi', 'EPOS'),
    ).toThrow();
    expect(() => printerEndpoint('https://printer.local/admin', 'EPOS')).toThrow();
    expect(
      printerEndpoint('https://printer.local/cgi-bin/epos/service.cgi?devid=local_printer', 'EPOS')
        .hostname,
    ).toBe('printer.local');
  });
});
