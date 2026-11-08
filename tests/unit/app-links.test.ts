import { describe, expect, it } from 'vitest';
import { appLink } from '../../src/services/app-links';
describe('links below a GitHub Pages repository', () => {
  it('keeps cash and account links inside the staff application', () => {
    expect(appLink('/cassa', '/plateform-core/staff/', 'staff')).toBe(
      '/plateform-core/staff/cassa',
    );
    expect(appLink('/conti?tavolo=123', '/plateform-core/staff/', 'staff')).toBe(
      '/plateform-core/staff/conti?tavolo=123',
    );
  });
  it('preserves existing bases, external destinations and public table URLs', () => {
    for (const value of [
      '/plateform-core/staff/cassa',
      'https://ambrogiocorti.github.io/plateform-core/menu',
      '//example.org',
      'mailto:staff@example.org',
      '#dati',
    ])
      expect(appLink(value, '/plateform-core/staff/', 'staff')).toBe(value);
    expect(appLink('/tavolo/id', '/plateform-core/', 'public')).toBe('/plateform-core/tavolo/id');
    expect(appLink('/cassa', '/', 'staff')).toBe('/cassa');
  });
});
