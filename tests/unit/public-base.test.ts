import { describe, expect, it } from 'vitest';
import { publicAppPath, withPublicBase } from '../../src/services/public-base';
import { canonicalPublicUrl } from '../../src/services/public-site';
import type { PublicSite } from '../../src/types/domain';

describe('public site under a sub-folder', () => {
  it('maps browser paths to app paths and back', () => {
    expect(publicAppPath('/plateform/menu', '/plateform/')).toBe('/menu');
    expect(publicAppPath('/plateform/', '/plateform/')).toBe('/');
    expect(publicAppPath('/plateform', '/plateform/')).toBe('/');
    expect(publicAppPath('/plateform/menu?sede=roma', '/plateform/')).toBe('/menu?sede=roma');
    expect(withPublicBase('/sedi/roma', '/plateform/')).toBe('/plateform/sedi/roma');
    expect(withPublicBase('/', '/plateform/')).toBe('/plateform/');
  });

  it('leaves the root deployment and foreign links untouched', () => {
    expect(publicAppPath('/menu', '/')).toBe('/menu');
    expect(withPublicBase('/menu', '/')).toBe('/menu');
    expect(withPublicBase('//evil.example/x', '/plateform/')).toBe('//evil.example/x');
    expect(withPublicBase('https://example.it/', '/plateform/')).toBe('https://example.it/');
    expect(publicAppPath('/plateformx/menu', '/plateform/')).toBe('/plateformx/menu');
  });

  it('keeps the folder in the canonical URL', () => {
    const site = { multi_venue: false, venues: [] } as unknown as PublicSite;
    expect(
      canonicalPublicUrl(site, '/menu', '', 'https://ambrogiocorti.github.io', '/plateform/'),
    ).toBe('https://ambrogiocorti.github.io/plateform/menu');
    expect(canonicalPublicUrl(site, '/menu', '', 'https://plateform.site')).toBe(
      'https://plateform.site/menu',
    );
  });
});
