// Auth identities use an email shape; the generated address is an internal
// staff identifier and does not imply a real inbox at the venue domain.
function identifierParts(value: string): string[] {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

export function automaticStaffIdentifier(displayName: string, venueName: string): string {
  const name = identifierParts(displayName);
  const venue = identifierParts(venueName);
  if (name.length < 2 || venue.length === 0) return '';
  const localPart = name.join('.').slice(0, 64).replace(/\.$/, '');
  const domain = venue.join('').slice(0, 63);
  return `${localPart}@${domain}.it`;
}
