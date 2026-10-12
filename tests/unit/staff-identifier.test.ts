import { describe, expect, it } from 'vitest';
import { automaticStaffIdentifier } from '../../src/auth/staff-identifier';

describe('Automatic staff login identifier', () => {
  it('combines first name, surname and venue with a .it domain', () => {
    expect(automaticStaffIdentifier('Mario Rossi', 'Sede collaudo')).toBe(
      'mario.rossi@sedecollaudo.it',
    );
  });

  it('normalizes accents and compound surnames and venue names', () => {
    expect(automaticStaffIdentifier('José De Luca', 'Cernusco sul Naviglio')).toBe(
      'jose.de.luca@cernuscosulnaviglio.it',
    );
  });

  it('does not suggest an identifier without a full name or a venue', () => {
    expect(automaticStaffIdentifier('Mario', 'Sede collaudo')).toBe('');
    expect(automaticStaffIdentifier('Mario Rossi', '')).toBe('');
  });

  it('produces a different domain when the chosen venue changes', () => {
    expect(automaticStaffIdentifier('Mario Rossi', 'Sede Milano')).toBe(
      'mario.rossi@sedemilano.it',
    );
    expect(automaticStaffIdentifier('Mario Rossi', 'Sede Roma')).toBe('mario.rossi@sederoma.it');
  });
});
