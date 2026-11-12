// Guest favorites are explicitly local to this browser. The QR customer session
// is not a persistent customer identity and must never be used as an account.
function storageKey(venueId: string): string {
  return `plateform-guest-favorites:${venueId}`;
}

export function readGuestFavorites(venueId: string): Set<string> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(storageKey(venueId)) ?? '[]');
    if (!Array.isArray(parsed)) return new Set();
    return new Set(
      parsed.filter(
        (value): value is string =>
          typeof value === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(value),
      ),
    );
  } catch {
    return new Set();
  }
}

export function writeGuestFavorites(venueId: string, ids: ReadonlySet<string>): boolean {
  try {
    localStorage.setItem(storageKey(venueId), JSON.stringify([...ids]));
    return true;
  } catch {
    return false;
  }
}
